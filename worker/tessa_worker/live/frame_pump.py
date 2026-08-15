import asyncio
import base64
import binascii
import contextlib
import logging
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Protocol
from uuid import UUID

from playwright.async_api import BrowserContext, Page
from playwright.async_api import Error as PlaywrightError

from tessa_api.schemas.events import TileFramePayload
from tessa_worker.live.uplink import DemandListener, TileDemand
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.live.frame_pump")

SOURCE_FPS = 60
SOURCE_OVERSAMPLE = 2
BURST_FACTOR = 3
BURST_WINDOW_SECONDS = 1.0
FRAME_BUDGET_BYTES = 100_000
WIDTH_STEP = 0.75
MIN_WIDTH = 320
QUALITY_STEP = 10
QUALITY_FLOOR = 30
SETTLE_SECONDS = 0.6
PROBE_TIMEOUT_SECONDS = 3.0
CDP_TIMEOUT_SECONDS = 5.0
JPEG_HEADER_CHARS = 8192
START_EVENT = "Page.screencastFrame"
SOF_MARKERS = frozenset(
    {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
)
STANDALONE_MARKERS = frozenset({0x01, 0xD8, *range(0xD0, 0xD8)})
END_OF_IMAGE = 0xD9

Clock = Callable[[], float]
CdpErrors = (PlaywrightError, TimeoutError)


class CdpSession(Protocol):
    async def send(self, method: str, params: dict[str, Any] | None = None) -> Any: ...

    def on(self, event: str, f: Callable[..., Any]) -> Any: ...

    async def detach(self) -> None: ...


class LiveUplink(Protocol):
    async def submit(self, payload: TileFramePayload) -> None: ...

    def watch_demand(self, session_id: UUID, listener: DemandListener) -> Callable[[], None]: ...

    def forget(self, session_id: UUID) -> None: ...


class Phase(StrEnum):
    stopped = "stopped"
    probing = "probing"
    steady = "steady"


@dataclass(frozen=True, slots=True)
class PumpLimits:
    max_fps: int
    quality: int
    max_width: int

    @classmethod
    def from_settings(cls, settings: WorkerSettings) -> "PumpLimits":
        return cls(
            max_fps=max(settings.live_grid_max_fps, settings.live_focus_max_fps),
            quality=max(settings.live_grid_quality, settings.live_focus_quality),
            max_width=max(settings.live_grid_max_width, settings.live_focus_max_width),
        )


@dataclass(frozen=True, slots=True)
class ScreencastParams:
    every_nth_frame: int
    quality: int
    max_width: int


@dataclass(slots=True)
class PumpStats:
    received: int = 0
    forwarded: int = 0
    rate_dropped: int = 0
    refreshes: int = 0
    restarts: int = 0
    oversize_frames: int = 0
    degrades: int = 0
    bytes_forwarded: int = 0
    ack_failures: int = 0


def every_nth_frame(max_fps: int) -> int:
    return max(1, SOURCE_FPS // (SOURCE_OVERSAMPLE * max_fps))


def decoded_size(data_b64: str) -> int:
    padding = data_b64.count("=", max(0, len(data_b64) - 2))
    return len(data_b64) * 3 // 4 - padding


def jpeg_dimensions(data_b64: str) -> tuple[int, int] | None:
    prefix = data_b64[:JPEG_HEADER_CHARS]
    try:
        raw = base64.b64decode(prefix[: len(prefix) // 4 * 4])
    except (ValueError, binascii.Error):
        return None
    if raw[:2] != b"\xff\xd8":
        return None
    offset = 2
    while offset + 4 <= len(raw):
        if raw[offset] != 0xFF:
            return None
        marker = raw[offset + 1]
        if marker == 0xFF:
            offset += 1
            continue
        if marker == END_OF_IMAGE:
            return None
        if marker in STANDALONE_MARKERS:
            offset += 2
            continue
        if marker in SOF_MARKERS:
            if offset + 9 > len(raw):
                return None
            height = int.from_bytes(raw[offset + 5 : offset + 7], "big")
            width = int.from_bytes(raw[offset + 7 : offset + 9], "big")
            return (width, height) if width > 0 and height > 0 else None
        offset += 2 + int.from_bytes(raw[offset + 2 : offset + 4], "big")
    return None


def captured_at(metadata: dict[str, Any]) -> datetime:
    timestamp = metadata.get("timestamp")
    if isinstance(timestamp, int | float) and timestamp > 0:
        return datetime.fromtimestamp(timestamp, UTC)
    return datetime.now(UTC)


class FramePump:
    def __init__(
        self,
        session_id: UUID,
        cdp: CdpSession,
        uplink: LiveUplink,
        page_url: Callable[[], str],
        limits: PumpLimits,
        clock: Clock = time.monotonic,
        settle_seconds: float = SETTLE_SECONDS,
    ) -> None:
        self.session_id = session_id
        self.stats = PumpStats()
        self._cdp = cdp
        self._uplink = uplink
        self._page_url = page_url
        self._limits = limits
        self._clock = clock
        self._settle_seconds = settle_seconds
        self._demand = TileDemand(max_fps=0, quality=limits.quality, max_width=limits.max_width)
        self._width_cap: int | None = None
        self._quality_cap: int | None = None
        self._phase = Phase.stopped
        self._running_params: ScreencastParams | None = None
        self._refresh_requested = False
        self._bursting = False
        self._running_nth = 1
        self._arrivals: deque[float] = deque()
        self._frame_seq = 0
        self._last_forwarded: float | None = None
        self._wake = asyncio.Event()
        self._probe_frame_seen = asyncio.Event()
        self._settle_handle: asyncio.TimerHandle | None = None
        self._control: asyncio.Task[None] | None = None
        self._unwatch: Callable[[], None] | None = None
        self._closed = False

    @classmethod
    async def attach(
        cls,
        session_id: UUID,
        context: BrowserContext,
        page: Page,
        uplink: LiveUplink,
        limits: PumpLimits,
        settle_seconds: float = SETTLE_SECONDS,
    ) -> "FramePump":
        cdp = await context.new_cdp_session(page)
        pump = cls(session_id, cdp, uplink, lambda: page.url, limits, settle_seconds=settle_seconds)
        pump.start()
        return pump

    @property
    def phase(self) -> Phase:
        return self._phase

    @property
    def demand(self) -> TileDemand:
        return self._demand

    def start(self) -> None:
        self._cdp.on(START_EVENT, self._on_frame)
        self._control = asyncio.create_task(self._control_loop(), name=f"pump-{self.session_id}")
        self._unwatch = self._uplink.watch_demand(self.session_id, self._on_demand)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._unwatch is not None:
            self._unwatch()
        self._cancel_settle()
        control, self._control = self._control, None
        if control is not None:
            control.cancel()
            await asyncio.gather(control, return_exceptions=True)
        await self._stop_screencast()
        try:
            async with asyncio.timeout(CDP_TIMEOUT_SECONDS):
                await self._cdp.detach()
        except CdpErrors:
            logger.debug("pump_detach_failed", extra={"session_id": str(self.session_id)})
        self._uplink.forget(self.session_id)

    def _on_demand(self, demand: TileDemand) -> None:
        clamped = TileDemand(
            max_fps=min(demand.max_fps, self._limits.max_fps),
            quality=min(demand.quality, self._limits.quality),
            max_width=min(demand.max_width, self._limits.max_width),
        )
        if (clamped.quality, clamped.max_width) != (self._demand.quality, self._demand.max_width):
            self._width_cap = None
            self._quality_cap = None
        self._demand = clamped
        self._wake.set()

    def _wanted(self) -> ScreencastParams | None:
        if self._demand.max_fps == 0:
            return None
        width = self._demand.max_width
        quality = self._demand.quality
        return ScreencastParams(
            every_nth_frame=every_nth_frame(self._demand.max_fps),
            quality=quality if self._quality_cap is None else min(quality, self._quality_cap),
            max_width=width if self._width_cap is None else min(width, self._width_cap),
        )

    async def _control_loop(self) -> None:
        while not self._closed:
            await self._wake.wait()
            self._wake.clear()
            try:
                await self._converge()
            except CdpErrors:
                logger.debug("pump_control_stopped", extra={"session_id": str(self.session_id)})
                self._phase = Phase.stopped
                self._running_params = None
                return
            except Exception:
                logger.exception("pump_control_failed", extra={"session_id": str(self.session_id)})

    async def _converge(self) -> None:
        wanted = self._wanted()
        if wanted is None:
            await self._stop_screencast()
            return
        steady = self._phase is Phase.steady and self._running_params == wanted
        if not steady or self._refresh_requested:
            await self._probe(wanted)
            return
        wanted_nth = wanted.every_nth_frame if self._bursting else 1
        if wanted_nth != self._running_nth:
            await self._change_sampling(wanted, wanted_nth)

    async def _probe(self, wanted: ScreencastParams) -> None:
        if self._refresh_requested:
            self.stats.refreshes += 1
        self._refresh_requested = False
        self._bursting = False
        self._arrivals.clear()
        self._cancel_settle()
        await self._stop_screencast()
        self._probe_frame_seen.clear()
        self._phase = Phase.probing
        self._running_params = wanted
        self._running_nth = 1
        await self._start_screencast(wanted, every_nth=1)
        await self._wait_for_probe_frame()
        if not self._closed and self._wanted() == wanted:
            self._phase = Phase.steady

    async def _change_sampling(self, wanted: ScreencastParams, every_nth: int) -> None:
        self.stats.restarts += 1
        await self._stop_screencast(keep_running_params=True)
        await self._start_screencast(wanted, every_nth=every_nth)
        self._running_nth = every_nth

    async def _wait_for_probe_frame(self) -> None:
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(PROBE_TIMEOUT_SECONDS):
                await self._probe_frame_seen.wait()

    def _track_arrival(self, now: float) -> None:
        if self._bursting:
            return
        self._arrivals.append(now)
        while self._arrivals and now - self._arrivals[0] > BURST_WINDOW_SECONDS:
            self._arrivals.popleft()
        if len(self._arrivals) > BURST_FACTOR * max(self._demand.max_fps, 1):
            self._bursting = True
            self._arrivals.clear()
            self._wake.set()

    async def _start_screencast(self, params: ScreencastParams, every_nth: int) -> None:
        async with asyncio.timeout(CDP_TIMEOUT_SECONDS):
            await self._cdp.send(
                "Page.startScreencast",
                {
                    "format": "jpeg",
                    "quality": params.quality,
                    "maxWidth": params.max_width,
                    "everyNthFrame": every_nth,
                },
            )

    async def _stop_screencast(self, keep_running_params: bool = False) -> None:
        was_running = self._phase is not Phase.stopped
        if not keep_running_params:
            self._phase = Phase.stopped
            self._running_params = None
        if not was_running:
            return
        self._cancel_settle()
        try:
            async with asyncio.timeout(CDP_TIMEOUT_SECONDS):
                await self._cdp.send("Page.stopScreencast")
        except CdpErrors:
            logger.debug("pump_stop_failed", extra={"session_id": str(self.session_id)})

    def _cancel_settle(self) -> None:
        if self._settle_handle is not None:
            self._settle_handle.cancel()
            self._settle_handle = None

    def _arm_settle(self) -> None:
        self._cancel_settle()
        if self._closed:
            return
        self._settle_handle = asyncio.get_running_loop().call_later(
            self._settle_seconds, self._request_refresh
        )

    def _request_refresh(self) -> None:
        self._settle_handle = None
        if self._phase is Phase.steady and not self._closed:
            self._refresh_requested = True
            self._wake.set()

    async def _on_frame(self, params: dict[str, Any]) -> None:
        try:
            await self._handle_frame(params)
        finally:
            await self._acknowledge(params.get("sessionId"))

    async def _handle_frame(self, params: dict[str, Any]) -> None:
        self.stats.received += 1
        if self._closed or self._phase is Phase.stopped:
            return
        probing = self._phase is Phase.probing
        first_probe_frame = probing and not self._probe_frame_seen.is_set()
        now = self._clock()
        if not probing:
            self._track_arrival(now)
        if not first_probe_frame and self._rate_gate_closed(now):
            self.stats.rate_dropped += 1
            if not probing:
                self._arm_settle()
            return
        data = str(params["data"])
        size = decoded_size(data)
        dimensions = jpeg_dimensions(data) or self._fallback_dimensions(params)
        self._last_forwarded = now
        payload = TileFramePayload(
            browser_session_id=self.session_id,
            frame_seq=self._frame_seq,
            mime="image/jpeg",
            width=dimensions[0],
            height=dimensions[1],
            data_b64=data,
            page_url=self._page_url() or None,
            captured_at=captured_at(params.get("metadata", {})),
        )
        self._frame_seq += 1
        await self._uplink.submit(payload)
        self.stats.forwarded += 1
        self.stats.bytes_forwarded += size
        if probing:
            self._probe_frame_seen.set()
        elif self._bursting:
            self._arm_settle()
        else:
            self._cancel_settle()
        self._enforce_budget(size)

    def _rate_gate_closed(self, now: float) -> bool:
        if self._last_forwarded is None or self._demand.max_fps == 0:
            return False
        return now - self._last_forwarded < 1 / self._demand.max_fps

    @staticmethod
    def _fallback_dimensions(params: dict[str, Any]) -> tuple[int, int]:
        metadata = params.get("metadata", {})
        return max(1, int(metadata.get("deviceWidth", 1))), max(
            1, int(metadata.get("deviceHeight", 1))
        )

    def _enforce_budget(self, size: int) -> None:
        if size <= FRAME_BUDGET_BYTES or self._running_params is None:
            return
        self.stats.oversize_frames += 1
        current_width = self._running_params.max_width
        current_quality = self._running_params.quality
        if int(current_width * WIDTH_STEP) >= MIN_WIDTH:
            self._width_cap = int(current_width * WIDTH_STEP)
        elif current_quality - QUALITY_STEP >= QUALITY_FLOOR:
            self._quality_cap = current_quality - QUALITY_STEP
        else:
            return
        self.stats.degrades += 1
        self._wake.set()

    async def _acknowledge(self, frame_session: Any) -> None:
        if frame_session is None:
            return
        try:
            async with asyncio.timeout(CDP_TIMEOUT_SECONDS):
                await self._cdp.send("Page.screencastFrameAck", {"sessionId": frame_session})
        except CdpErrors:
            self.stats.ack_failures += 1
