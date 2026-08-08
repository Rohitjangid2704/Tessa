import asyncio
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import IntEnum, StrEnum
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, WebSocket
from pydantic import ValidationError
from sqlalchemy.exc import InterfaceError, OperationalError
from starlette.websockets import WebSocketDisconnect

from tessa_api.db.models import User
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.streams import (
    StreamClosingEvent,
    StreamClosingPayload,
    StreamErrorEvent,
    StreamErrorPayload,
    StreamHeartbeatEvent,
    StreamHeartbeatPayload,
    StreamHelloEvent,
    StreamHelloPayload,
    StreamReplayEndEvent,
    StreamReplayEndPayload,
    StreamResyncRequiredEvent,
    StreamResyncRequiredPayload,
    TileAckMessage,
    TileSubscribeMessage,
    stream_client_message_adapter,
)
from tessa_api.services.tickets import TicketError, TicketRegistry, verify_ticket
from tessa_api.settings import Settings
from tessa_api.streams.hub import Hub, OutboundMessage, Subscription, Termination
from tessa_api.streams.log import (
    LogBounds,
    iter_replay_batches,
    read_active_browser_session_ids,
    read_log_bounds,
    run_row_exists,
    to_envelope,
)
from tessa_api.streams.tiles import ClientTiles, TileLimitExceededError

logger = logging.getLogger("tessa_api.streams")

router = APIRouter(tags=["streams"], include_in_schema=False)

DATABASE_ERRORS = (ConnectionError, OperationalError, InterfaceError)
CLOSE_FAILURES = (WebSocketDisconnect, RuntimeError, OSError)

StreamControlEvent = (
    StreamHelloEvent
    | StreamReplayEndEvent
    | StreamResyncRequiredEvent
    | StreamHeartbeatEvent
    | StreamClosingEvent
    | StreamErrorEvent
)
ClosingReason = Literal["max_age", "shutdown", "slow_consumer"]
ResyncReason = Literal["gap_too_large", "retention"]


class CloseCode(IntEnum):
    normal = 1000
    going_away = 1001
    try_again_later = 1013
    bad_client_message = 4400
    unauthenticated = 4401
    forbidden = 4403
    unknown_run = 4404
    max_age = 4408
    slow_consumer = 4413
    too_many_connections = 4429


class ReaderOutcome(StrEnum):
    disconnected = "disconnected"
    bad_message = "bad_message"


@dataclass(frozen=True, slots=True)
class ReaderResult:
    outcome: ReaderOutcome
    detail: str | None = None


ClientMessage = TileSubscribeMessage | TileAckMessage
ClientMessageHandler = Callable[[ClientMessage], str | None]

BAD_MESSAGE_DETAIL = "Client message does not match StreamClientMessage"


@dataclass(frozen=True, slots=True)
class Rejection:
    code: CloseCode
    reason: str


@dataclass(frozen=True, slots=True)
class Admission:
    user_id: UUID
    run_id: UUID
    last_seq: int | None


@dataclass(frozen=True, slots=True)
class Resync:
    reason: ResyncReason
    min_seq: int


class ClientGone(Exception):
    pass


ReaderTask = asyncio.Task[ReaderResult]
QueueWaiter = asyncio.Task[OutboundMessage | Termination]
TileWaiter = asyncio.Task[bool]


def origin_allowed(origin: str, allowed_origins: list[str]) -> bool:
    return origin.rstrip("/").lower() in {allowed.lower() for allowed in allowed_origins}


def parse_uuid(value: str) -> UUID | None:
    try:
        return UUID(value)
    except ValueError:
        return None


def parse_last_seq(value: str | None) -> Rejection | int | None:
    if value is None:
        return None
    if not value.isascii() or not value.isdigit():
        return Rejection(CloseCode.bad_client_message, "invalid_last_seq")
    return int(value)


def decide_resync(bounds: LogBounds, last_seq: int, max_events: int) -> Resync | None:
    if bounds.min_seq is not None and last_seq + 1 < bounds.min_seq:
        return Resync("retention", bounds.min_seq)
    if last_seq > bounds.head_seq:
        return Resync("retention", bounds.min_seq or 1)
    if bounds.head_seq - last_seq > max_events:
        return Resync("gap_too_large", bounds.head_seq - max_events + 1)
    return None


async def admit(
    websocket: WebSocket,
    run_id_text: str,
    settings: Settings,
    session_factory: SessionFactory,
    tickets: TicketRegistry,
) -> Admission | Rejection:
    origin = websocket.headers.get("origin")
    if origin is not None and not origin_allowed(origin, settings.cors_origins):
        return Rejection(CloseCode.forbidden, "origin_not_allowed")
    ticket = websocket.query_params.get("ticket")
    if not ticket:
        return Rejection(CloseCode.unauthenticated, "ticket_required")
    try:
        claims = verify_ticket(settings, ticket)
    except TicketError as error:
        return Rejection(CloseCode.unauthenticated, error.reason)
    if not tickets.consume(claims.token_id, claims.expires_at):
        return Rejection(CloseCode.unauthenticated, "ticket_already_used")
    run_id = parse_uuid(run_id_text)
    if run_id is None:
        return Rejection(CloseCode.unknown_run, "unknown_run")
    if claims.run_id != run_id:
        return Rejection(CloseCode.forbidden, "ticket_run_mismatch")
    last_seq = parse_last_seq(websocket.query_params.get("last_seq"))
    if isinstance(last_seq, Rejection):
        return last_seq
    async with session_factory() as session:
        user = await session.get(User, claims.user_id)
    if user is None or not user.is_active:
        return Rejection(CloseCode.unauthenticated, "unknown_or_inactive_user")
    return Admission(user_id=user.id, run_id=run_id, last_seq=last_seq)


def raw_payload(message: Mapping[str, Any]) -> str | bytes:
    text = message.get("text")
    if text is not None:
        return str(text)
    return bytes(message.get("bytes") or b"")


async def read_client_messages(websocket: WebSocket, handle: ClientMessageHandler) -> ReaderResult:
    while True:
        try:
            message = await websocket.receive()
        except CLOSE_FAILURES:
            return ReaderResult(ReaderOutcome.disconnected)
        if message["type"] == "websocket.disconnect":
            return ReaderResult(ReaderOutcome.disconnected)
        try:
            client_message = stream_client_message_adapter.validate_json(raw_payload(message))
        except ValidationError:
            return ReaderResult(ReaderOutcome.bad_message, BAD_MESSAGE_DETAIL)
        rejection = handle(client_message)
        if rejection is not None:
            return ReaderResult(ReaderOutcome.bad_message, rejection)


async def close_quietly(websocket: WebSocket, code: CloseCode, reason: str) -> None:
    try:
        await websocket.close(code=code.value, reason=reason)
    except CLOSE_FAILURES:
        logger.debug("stream_close_failed", extra={"close_code": code.value})


class RunStreamSession:
    def __init__(
        self,
        websocket: WebSocket,
        settings: Settings,
        session_factory: SessionFactory,
        hub: Hub,
        subscription: Subscription,
        tiles: ClientTiles,
        admission: Admission,
    ) -> None:
        self._websocket = websocket
        self._settings = settings
        self._session_factory = session_factory
        self._hub = hub
        self._subscription = subscription
        self._tiles = tiles
        self._admission = admission
        self._run_id = admission.run_id

    async def run(self) -> None:
        reader = asyncio.create_task(read_client_messages(self._websocket, self._handle_message))
        try:
            await self._serve(reader)
        except ClientGone:
            logger.debug("stream_client_gone", extra={"run_id": str(self._run_id)})
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)

    def _handle_message(self, message: ClientMessage) -> str | None:
        if isinstance(message, TileSubscribeMessage):
            try:
                self._hub.tiles.subscribe(self._run_id, self._tiles, message.payload.tiles)
            except TileLimitExceededError as error:
                return str(error)
            return None
        self._hub.tiles.acknowledge(self._tiles, message.payload)
        return None

    async def _serve(self, reader: ReaderTask) -> None:
        started = asyncio.get_running_loop().time()
        async with self._session_factory() as session:
            bounds = await read_log_bounds(session, self._run_id)
            known = bounds.head_seq > 0 or await run_row_exists(session, self._run_id)
            active_sessions = (
                await read_active_browser_session_ids(session, self._run_id) if known else []
            )
        if not known:
            await close_quietly(self._websocket, CloseCode.unknown_run, "unknown_run")
            return
        for session_id in active_sessions:
            self._hub.tiles.register_session(session_id, self._run_id)
        await self._send_control(self._hello(bounds))
        last_seq = self._admission.last_seq or 0
        resync = decide_resync(bounds, last_seq, self._settings.stream_replay_max_events)
        if resync is not None:
            await self._send_control(self._resync_required(resync))
            await close_quietly(self._websocket, CloseCode.normal, "resync_required")
            return
        await self._replay(last_seq, bounds.head_seq)
        await self._send_control(
            StreamReplayEndEvent(
                type="stream.replay_end",
                run_id=self._run_id,
                seq=None,
                ts=datetime.now(UTC),
                payload=StreamReplayEndPayload(through_seq=bounds.head_seq),
            )
        )
        await self._live(reader, bounds.head_seq, started)

    def _hello(self, bounds: LogBounds) -> StreamHelloEvent:
        return StreamHelloEvent(
            type="stream.hello",
            run_id=self._run_id,
            seq=None,
            ts=datetime.now(UTC),
            payload=StreamHelloPayload(
                run_id=self._run_id,
                head_seq=bounds.head_seq,
                resumed_from=self._admission.last_seq,
                heartbeat_seconds=self._settings.stream_heartbeat_seconds,
                limits=self._hub.tiles.policy.limits(),
                feed=None,
            ),
        )

    def _resync_required(self, resync: Resync) -> StreamResyncRequiredEvent:
        return StreamResyncRequiredEvent(
            type="stream.resync_required",
            run_id=self._run_id,
            seq=None,
            ts=datetime.now(UTC),
            payload=StreamResyncRequiredPayload(reason=resync.reason, min_seq=resync.min_seq),
        )

    async def _replay(self, last_seq: int, through_seq: int) -> None:
        async for batch in iter_replay_batches(
            self._session_factory, self._run_id, last_seq, through_seq
        ):
            for row in batch:
                await self._send_text(to_envelope(row).model_dump_json())

    async def _live(self, reader: ReaderTask, through_seq: int, started: float) -> None:
        loop = asyncio.get_running_loop()
        heartbeat_seconds = self._settings.stream_heartbeat_seconds
        deadline = started + self._settings.stream_max_age_seconds
        next_heartbeat = loop.time() + heartbeat_seconds
        waiter: QueueWaiter | None = None
        tile_waiter: TileWaiter | None = None
        try:
            while True:
                now = loop.time()
                if now >= deadline:
                    await self._finish("max_age", CloseCode.max_age)
                    return
                if now >= next_heartbeat:
                    await self._send_heartbeat()
                    next_heartbeat = now + heartbeat_seconds
                self._tiles.changed.clear()
                await self._send_ready_frames()
                if waiter is None:
                    waiter = asyncio.create_task(self._subscription.queue.get())
                if tile_waiter is None:
                    tile_waiter = asyncio.create_task(self._tiles.changed.wait())
                wake_at = min(deadline, next_heartbeat)
                tile_wait = self._tiles.seconds_until_ready()
                if tile_wait is not None:
                    wake_at = min(wake_at, loop.time() + tile_wait)
                done, _ = await asyncio.wait(
                    {waiter, tile_waiter, reader},
                    timeout=max(0.0, wake_at - loop.time()),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if reader in done:
                    await self._handle_reader_outcome(reader.result())
                    return
                if tile_waiter in done:
                    tile_waiter = None
                if waiter not in done:
                    continue
                item = waiter.result()
                waiter = None
                if isinstance(item, Termination):
                    await self._finish(item.reason, termination_close_code(item))
                    return
                if item.seq is None or item.seq > through_seq:
                    await self._send_text(item.text)
        finally:
            for pending in (waiter, tile_waiter):
                if pending is not None:
                    pending.cancel()

    async def _send_ready_frames(self) -> None:
        for frame in self._tiles.pop_ready():
            await self._send_text(frame.text())

    async def _handle_reader_outcome(self, result: ReaderResult) -> None:
        if result.outcome is ReaderOutcome.disconnected:
            return
        await self._send_control(
            StreamErrorEvent(
                type="stream.error",
                run_id=self._run_id,
                seq=None,
                ts=datetime.now(UTC),
                payload=StreamErrorPayload(
                    code="bad_request", message=result.detail or BAD_MESSAGE_DETAIL
                ),
            )
        )
        await close_quietly(self._websocket, CloseCode.bad_client_message, "bad_client_message")

    async def _send_heartbeat(self) -> None:
        await self._send_control(
            StreamHeartbeatEvent(
                type="stream.heartbeat",
                run_id=self._run_id,
                seq=None,
                ts=datetime.now(UTC),
                payload=StreamHeartbeatPayload(),
            )
        )

    async def _finish(self, reason: ClosingReason, code: CloseCode) -> None:
        await self._send_control(
            StreamClosingEvent(
                type="stream.closing",
                run_id=self._run_id,
                seq=None,
                ts=datetime.now(UTC),
                payload=StreamClosingPayload(reason=reason),
            )
        )
        await close_quietly(self._websocket, code, reason)

    async def _send_control(self, event: StreamControlEvent) -> None:
        await self._send_text(event.model_dump_json())

    async def _send_text(self, text: str) -> None:
        try:
            await self._websocket.send_text(text)
        except CLOSE_FAILURES as error:
            raise ClientGone from error


def termination_close_code(termination: Termination) -> CloseCode:
    if termination.reason == "slow_consumer":
        return CloseCode.slow_consumer
    return CloseCode.going_away


@router.websocket("/ws/v1/runs/{run_id}")
async def run_stream(websocket: WebSocket, run_id: str) -> None:
    settings: Settings = websocket.app.state.settings
    session_factory: SessionFactory = websocket.app.state.session_factory
    hub: Hub = websocket.app.state.hub
    tickets: TicketRegistry = websocket.app.state.ticket_registry
    await websocket.accept()
    try:
        admission = await admit(websocket, run_id, settings, session_factory, tickets)
        if isinstance(admission, Rejection):
            await close_quietly(websocket, admission.code, admission.reason)
            return
        subscription = hub.subscribe_run(
            admission.run_id,
            admission.user_id,
            settings.ws_send_queue_max,
            settings.ws_max_connections_per_user,
        )
        if subscription is None:
            await close_quietly(websocket, CloseCode.too_many_connections, "too_many_connections")
            return
        tiles = subscription.tiles
        if tiles is None:
            raise RuntimeError("a run subscription always carries its tile state")
        try:
            await RunStreamSession(
                websocket, settings, session_factory, hub, subscription, tiles, admission
            ).run()
        finally:
            subscription.release()
    except DATABASE_ERRORS:
        logger.warning("stream_database_unavailable")
        await close_quietly(websocket, CloseCode.try_again_later, "database_unavailable")
