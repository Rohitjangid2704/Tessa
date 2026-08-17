import asyncio
import base64
import time
from collections.abc import Callable
from typing import Any
from uuid import UUID

from playwright.async_api import Error as PlaywrightError

from tessa_api.schemas.events import TileFramePayload
from tessa_worker.live.uplink import PAUSED, DemandListener, TileDemand

PATIENCE_SECONDS = 15.0
POLL_SECONDS = 0.01


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def fake_jpeg(width: int, height: int, padding_bytes: int = 0) -> bytes:
    app0 = b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof = b"\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big")
    sof += b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    scan = b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00" + b"\x00" * padding_bytes
    return b"\xff\xd8" + app0 + sof + scan + b"\xff\xd9"


def fake_jpeg_b64(width: int = 640, height: int = 360, padding_bytes: int = 0) -> str:
    return base64.b64encode(fake_jpeg(width, height, padding_bytes)).decode()


class FakeCdp:
    def __init__(self, log: list[str] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any] | None]] = []
        self.log = log if log is not None else []
        self.handlers: dict[str, list[Callable[..., Any]]] = {}
        self.failing: set[str] = set()
        self.failures: list[str] = []
        self.detached = False
        self._frame_counter = 0

    async def send(self, method: str, params: dict[str, Any] | None = None) -> Any:
        if method in self.failing:
            self.failures.append(method)
            raise PlaywrightError("Target page, context or browser has been closed")
        self.calls.append((method, params))
        self.log.append(f"cdp:{method}")

    def on(self, event: str, f: Callable[..., Any]) -> None:
        self.handlers.setdefault(event, []).append(f)

    async def detach(self) -> None:
        self.detached = True

    def methods(self) -> list[str]:
        return [method for method, _ in self.calls]

    def starts(self) -> list[dict[str, Any]]:
        return [params or {} for method, params in self.calls if method == "Page.startScreencast"]

    def acks(self) -> list[dict[str, Any]]:
        return [
            params or {} for method, params in self.calls if method == "Page.screencastFrameAck"
        ]

    async def emit_frame(self, data_b64: str | None = None, timestamp: float | None = None) -> None:
        self._frame_counter += 1
        params = {
            "data": data_b64 if data_b64 is not None else fake_jpeg_b64(),
            "metadata": {
                "deviceWidth": 1280,
                "deviceHeight": 720,
                "timestamp": timestamp if timestamp is not None else 1791186427.5,
            },
            "sessionId": self._frame_counter,
        }
        await asyncio.gather(
            *(handler(params) for handler in self.handlers["Page.screencastFrame"])
        )


class FakeUplink:
    def __init__(self, log: list[str] | None = None) -> None:
        self.log = log if log is not None else []
        self.payloads: list[TileFramePayload] = []
        self.listeners: dict[UUID, DemandListener] = {}
        self.forgotten: list[UUID] = []
        self.current: TileDemand = PAUSED
        self.hold: asyncio.Event | None = None

    async def submit(self, payload: TileFramePayload) -> None:
        self.payloads.append(payload)
        self.log.append(f"submit:{payload.frame_seq}")
        if self.hold is not None:
            await self.hold.wait()

    def watch_demand(self, session_id: UUID, listener: DemandListener) -> Callable[[], None]:
        self.listeners[session_id] = listener
        listener(self.current)

        def unwatch() -> None:
            self.listeners.pop(session_id, None)

        return unwatch

    def forget(self, session_id: UUID) -> None:
        self.forgotten.append(session_id)

    def set_demand(self, session_id: UUID, demand: TileDemand) -> None:
        self.current = demand
        self.listeners[session_id](demand)


async def eventually(
    predicate: Callable[[], bool], patience_seconds: float = PATIENCE_SECONDS
) -> None:
    deadline = time.monotonic() + patience_seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(POLL_SECONDS)
    raise AssertionError("condition did not become true in time")
