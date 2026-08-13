import asyncio
import contextlib
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

from tessa_api.schemas.enums import AdapterKind
from tessa_api.schemas.scenario import ScenarioStep, WebsocketMessageSpec, WebsocketStep
from tessa_api.schemas.steps import (
    WebsocketMessage,
    WebsocketStepRequest,
    WebsocketStepResponse,
)
from tessa_worker.adapters.base import Adapter, AdapterCapabilities, StepRecord
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.errors import AdapterError
from tessa_worker.adapters.http_core import elapsed_ms
from tessa_worker.adapters.net_core import NetworkAdapter, failure_message, identity_headers
from tessa_worker.adapters.payload import fit_items, fit_text, json_text
from tessa_worker.adapters.step_payloads import step_record

WEBSOCKET_CAPABILITIES = AdapterCapabilities()
READ_FACTOR = 4
OPEN_TIMEOUT_SECONDS = 15.0
CLOSE_TIMEOUT_SECONDS = 5.0
MESSAGE_OVERHEAD_BYTES = 32
WEBSOCKET_SCHEME_OF = {"http": "ws", "https": "wss", "ws": "ws", "wss": "wss"}


@dataclass(frozen=True)
class PlannedMessage:
    at_ms: int
    text: str


@dataclass
class Conversation:
    url: str
    opened_at: float | None = None
    sent: list[WebsocketMessage] = field(default_factory=list)
    received: list[WebsocketMessage] = field(default_factory=list)
    raw_bytes: int = 0
    truncated: bool = False
    server_closed: bool = False

    def elapsed_ms(self) -> int:
        return 0 if self.opened_at is None else elapsed_ms(self.opened_at)

    def seconds_until(self, at_ms: int) -> float:
        if self.opened_at is None:
            return 0.0
        return at_ms / 1000 - (time.perf_counter() - self.opened_at)

    def accept(self, message: str | bytes, max_messages: int, budget: int) -> bool:
        if len(self.received) >= max_messages:
            self.truncated = True
            return False
        text = message if isinstance(message, str) else f"<binary message of {len(message)} bytes>"
        self.raw_bytes += len(text.encode("utf-8"))
        if self.raw_bytes > budget:
            self.truncated = True
            return False
        self.received.append(WebsocketMessage(at_ms=self.elapsed_ms(), data=text))
        return True


def websocket_url(url: str) -> str:
    parts = urlsplit(url)
    scheme = WEBSOCKET_SCHEME_OF.get(parts.scheme.lower())
    if scheme is None or not parts.netloc:
        raise AdapterError("the websocket address is not an http, https, ws or wss URL")
    return urlunsplit(parts._replace(scheme=scheme))


class WebsocketAdapter(NetworkAdapter):
    kind = AdapterKind.websocket

    async def drive(self, step: ScenarioStep) -> StepRecord:
        if not isinstance(step, WebsocketStep):
            raise TypeError(f"the websocket adapter cannot drive a {step.adapter} step")
        started_at = datetime.now(UTC)
        clock = time.perf_counter()
        conversation = Conversation(url=self.context.interface.base_url + (step.path or ""))
        failure: str | None = None
        close_code: int | None = None
        close_reason: str | None = None
        try:
            close_code, close_reason = await self.converse(step, conversation)
        except Exception as error:
            failure = self.error_message(error)
            if failure is None:
                raise
        return self.record(
            step, conversation, failure, close_code, close_reason, elapsed_ms(clock), started_at
        )

    async def converse(
        self, step: WebsocketStep, conversation: Conversation
    ) -> tuple[int | None, str | None]:
        environment = self.context.environment
        conversation.url = websocket_url(
            self.context.interface.base_url + environment.substitute(step.path or "")
        )
        plan = self.plan(step)
        identity = await self.identities.identity(step.as_)
        async with (
            asyncio.timeout(self.timeout_seconds),
            connect(
                conversation.url,
                additional_headers=identity_headers(identity),
                open_timeout=min(OPEN_TIMEOUT_SECONDS, self.timeout_seconds),
                close_timeout=CLOSE_TIMEOUT_SECONDS,
                ping_interval=None,
                max_size=self.guard.read_budget(READ_FACTOR),
                compression=None,
            ) as connection,
        ):
            conversation.opened_at = time.perf_counter()
            await self.exchange(connection, plan, step.listen_ms, conversation)
            if not conversation.server_closed:
                return None, None
            return connection.close_code, connection.close_reason or None

    def plan(self, step: WebsocketStep) -> list[PlannedMessage]:
        ordered = sorted(step.messages, key=lambda message: message.at_ms)
        return [PlannedMessage(message.at_ms, self.message_text(message)) for message in ordered]

    def message_text(self, message: WebsocketMessageSpec) -> str:
        resolved = self.context.environment.substitute_json(message.data)
        return resolved if isinstance(resolved, str) else json_text(resolved)

    async def exchange(
        self,
        connection: ClientConnection,
        plan: list[PlannedMessage],
        listen_ms: int,
        conversation: Conversation,
    ) -> None:
        receiver = asyncio.create_task(self.receive(connection, conversation))
        try:
            await self.send_all(connection, plan, conversation, receiver)
            if not receiver.done():
                await asyncio.wait({receiver}, timeout=listen_ms / 1000)
        finally:
            receiver.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await receiver

    async def send_all(
        self,
        connection: ClientConnection,
        plan: list[PlannedMessage],
        conversation: Conversation,
        receiver: asyncio.Task[None],
    ) -> None:
        for message in plan:
            if await self.wait_for_offset(receiver, conversation, message.at_ms):
                return
            try:
                await connection.send(message.text)
            except ConnectionClosed:
                await asyncio.wait({receiver}, timeout=CLOSE_TIMEOUT_SECONDS)
                return
            conversation.sent.append(
                WebsocketMessage(at_ms=conversation.elapsed_ms(), data=message.text)
            )

    async def wait_for_offset(
        self, receiver: asyncio.Task[None], conversation: Conversation, at_ms: int
    ) -> bool:
        remaining = conversation.seconds_until(at_ms)
        if remaining > 0:
            await asyncio.wait({receiver}, timeout=remaining)
        return receiver.done()

    async def receive(self, connection: ClientConnection, conversation: Conversation) -> None:
        limits = self.context.limits
        budget = self.guard.read_budget(READ_FACTOR)
        try:
            async for message in connection:
                if not conversation.accept(message, limits.ws_max_messages, budget):
                    return
        except ConnectionClosed:
            pass
        conversation.server_closed = True

    def error_message(self, error: BaseException) -> str | None:
        known = failure_message(error, self.timeout_seconds)
        if known is not None:
            return known
        if isinstance(error, InvalidStatus):
            status = error.response.status_code
            return f"the server rejected the WebSocket handshake with HTTP {status}"
        if isinstance(error, WebSocketException | OSError):
            return f"{type(error).__name__}: {error}"
        return None

    def record(
        self,
        step: WebsocketStep,
        conversation: Conversation,
        failure: str | None,
        close_code: int | None,
        close_reason: str | None,
        latency_ms: int,
        started_at: datetime,
    ) -> StepRecord:
        guard = self.guard
        sent, sent_cut = self.safe_messages(conversation.sent)
        received, received_cut = self.safe_messages(conversation.received)
        request = WebsocketStepRequest(
            kind="websocket", url=guard.url(conversation.url), messages_sent=sent
        )
        truncated = conversation.truncated or sent_cut or received_cut
        response: WebsocketStepResponse | None = None
        if conversation.opened_at is not None:
            reason = None if close_reason is None else guard.text(close_reason).text
            response = WebsocketStepResponse(
                kind="websocket",
                messages_received=received,
                close_code=close_code,
                close_reason=reason,
                truncated=truncated,
            )
        return step_record(
            AdapterKind.websocket,
            guard,
            step.label or f"WS {step.path or '/'}",
            request,
            response,
            failure is None,
            failure,
            truncated,
            latency_ms,
            started_at,
        )

    def safe_messages(
        self, messages: list[WebsocketMessage]
    ) -> tuple[list[WebsocketMessage], bool]:
        cap = self.guard.cap
        texts = self.guard.protect_span([message.data for message in messages])
        fitted = [fit_text(text, cap) for text in texts]
        shaped = [
            WebsocketMessage(at_ms=message.at_ms, data=text)
            for message, (text, _) in zip(messages, fitted, strict=True)
        ]
        kept, dropped = fit_items(
            shaped, lambda item: len(item.data.encode("utf-8")) + MESSAGE_OVERHEAD_BYTES, cap
        )
        return kept, dropped or any(cut for _, cut in fitted)


async def open_websocket_adapter(context: AdapterContext) -> Adapter:
    return WebsocketAdapter(context)
