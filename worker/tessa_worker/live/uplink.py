import asyncio
import logging
import random
from collections import OrderedDict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from uuid import UUID

from pydantic import ValidationError
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

from tessa_api.schemas.events import FrameIngestMessage, TileDemandMessage, TileFramePayload
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.live.uplink")

FRAMES_PATH = "/internal/v1/frames"
SERVICE_KEY_HEADER = "X-Service-Key"
BACKOFF_SECONDS = (0.5, 1.0, 2.0, 5.0, 10.0)
BACKOFF_JITTER = 0.2
OPEN_TIMEOUT_SECONDS = 10.0
PING_INTERVAL_SECONDS = 20.0
PING_TIMEOUT_SECONDS = 20.0
REMEMBERED_DEMANDS = 512
STOP_TIMEOUT_SECONDS = 5.0
STABLE_SECONDS = 5.0


@dataclass(frozen=True, slots=True)
class TileDemand:
    max_fps: int
    quality: int
    max_width: int

    @property
    def paused(self) -> bool:
        return self.max_fps == 0


PAUSED = TileDemand(max_fps=0, quality=60, max_width=640)

DemandListener = Callable[[TileDemand], None]


def frames_url(api_internal_url: str) -> str:
    scheme, separator, rest = api_internal_url.partition("://")
    websocket_scheme = "wss" if scheme == "https" else "ws"
    return f"{websocket_scheme}{separator}{rest.rstrip('/')}{FRAMES_PATH}"


def backoff_delay(
    attempt: int,
    schedule: Sequence[float] = BACKOFF_SECONDS,
    jitter: Callable[[], float] = random.random,
) -> float:
    base = schedule[min(attempt, len(schedule) - 1)]
    return base * (1 + BACKOFF_JITTER * (2 * jitter() - 1))


class PendingFrame:
    def __init__(self, payload: TileFramePayload) -> None:
        self.payload = payload
        self.handled: asyncio.Future[None] = asyncio.get_running_loop().create_future()

    def resolve(self) -> None:
        if not self.handled.done():
            self.handled.set_result(None)


class FrameUplink:
    def __init__(
        self,
        settings: WorkerSettings,
        backoff: Sequence[float] = BACKOFF_SECONDS,
        jitter: Callable[[], float] = random.random,
    ) -> None:
        self._backoff = tuple(backoff)
        self._url = frames_url(settings.api_internal_url)
        self._service_key = settings.service_key.get_secret_value()
        self._jitter = jitter
        self._slots: dict[UUID, PendingFrame] = {}
        self._wake = asyncio.Event()
        self._demands: OrderedDict[UUID, TileDemand] = OrderedDict()
        self._listeners: dict[UUID, list[DemandListener]] = {}
        self._connected = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._closing = False
        self.frames_sent = 0
        self.frames_superseded = 0
        self.connections = 0

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    async def wait_connected(self, patience_seconds: float) -> None:
        async with asyncio.timeout(patience_seconds):
            await self._connected.wait()

    async def start(self) -> None:
        if self._task is not None:
            return
        self._closing = False
        self._task = asyncio.create_task(self._run(), name="frame-uplink")

    async def stop(self) -> None:
        self._closing = True
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.wait({task}, timeout=STOP_TIMEOUT_SECONDS)
        self._release_pending()
        self._connected.clear()

    async def submit(self, payload: TileFramePayload) -> None:
        if not self.connected:
            return
        pending = PendingFrame(payload)
        superseded = self._slots.get(payload.browser_session_id)
        if superseded is not None:
            self.frames_superseded += 1
            superseded.resolve()
        self._slots[payload.browser_session_id] = pending
        self._wake.set()
        await asyncio.shield(pending.handled)

    def demand_of(self, session_id: UUID) -> TileDemand:
        if not self.connected:
            return PAUSED
        return self._demands.get(session_id, PAUSED)

    def watch_demand(self, session_id: UUID, listener: DemandListener) -> Callable[[], None]:
        self._listeners.setdefault(session_id, []).append(listener)
        listener(self.demand_of(session_id))

        def unwatch() -> None:
            listeners = self._listeners.get(session_id)
            if listeners is not None and listener in listeners:
                listeners.remove(listener)
                if not listeners:
                    del self._listeners[session_id]

        return unwatch

    def forget(self, session_id: UUID) -> None:
        self._demands.pop(session_id, None)
        self._listeners.pop(session_id, None)
        pending = self._slots.pop(session_id, None)
        if pending is not None:
            pending.resolve()

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        attempt = 0
        while not self._closing:
            connected_at: float | None = None
            try:
                async with connect(
                    self._url,
                    additional_headers={SERVICE_KEY_HEADER: self._service_key},
                    open_timeout=OPEN_TIMEOUT_SECONDS,
                    ping_interval=PING_INTERVAL_SECONDS,
                    ping_timeout=PING_TIMEOUT_SECONDS,
                ) as socket:
                    connected_at = loop.time()
                    await self._serve(socket)
            except (OSError, WebSocketException, TimeoutError) as error:
                logger.warning("frame_uplink_connection_failed", extra={"error": repr(error)})
            finally:
                self._on_disconnected()
            if connected_at is not None and loop.time() - connected_at >= STABLE_SECONDS:
                attempt = 0
            await asyncio.sleep(backoff_delay(attempt, self._backoff, self._jitter))
            attempt += 1

    async def _serve(self, socket: ClientConnection) -> None:
        self.connections += 1
        self._connected.set()
        sender = asyncio.create_task(self._send_frames(socket))
        receiver = asyncio.create_task(self._receive_demands(socket))
        try:
            await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (sender, receiver):
                task.cancel()
            results = await asyncio.gather(sender, receiver, return_exceptions=True)
        for result in results:
            if isinstance(result, Exception):
                raise result

    async def _send_frames(self, socket: ClientConnection) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            while self._slots:
                session_id = next(iter(self._slots))
                pending = self._slots.pop(session_id)
                try:
                    await socket.send(
                        FrameIngestMessage(type="frame", payload=pending.payload).model_dump_json()
                    )
                finally:
                    pending.resolve()
                self.frames_sent += 1

    async def _receive_demands(self, socket: ClientConnection) -> None:
        async for raw in socket:
            try:
                message = TileDemandMessage.model_validate_json(raw)
            except ValidationError:
                logger.warning("frame_uplink_unreadable_message")
                continue
            payload = message.payload
            self._remember(
                payload.browser_session_id,
                TileDemand(payload.max_fps, payload.quality, payload.max_width),
            )
            self._notify(payload.browser_session_id)

    def _remember(self, session_id: UUID, demand: TileDemand) -> None:
        self._demands[session_id] = demand
        self._demands.move_to_end(session_id)
        while len(self._demands) > REMEMBERED_DEMANDS:
            self._demands.popitem(last=False)

    def _notify(self, session_id: UUID) -> None:
        demand = self.demand_of(session_id)
        for listener in tuple(self._listeners.get(session_id, ())):
            listener(demand)

    def _on_disconnected(self) -> None:
        was_connected = self._connected.is_set()
        self._connected.clear()
        self._demands.clear()
        self._release_pending()
        if was_connected:
            for session_id in tuple(self._listeners):
                self._notify(session_id)

    def _release_pending(self) -> None:
        for pending in self._slots.values():
            pending.resolve()
        self._slots.clear()
