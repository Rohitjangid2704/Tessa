import asyncio
import time
from collections import deque
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID

from tessa_api.schemas.events import (
    TILE_FPS_CEILING,
    TILE_MAX_UNACKED_FRAMES,
    TILE_QUALITY_CEILING,
    TILE_QUALITY_FLOOR,
    TILE_WIDTH_CEILING,
    TileFramePayload,
)
from tessa_api.schemas.streams import (
    StreamLimits,
    TileFrameEvent,
    TileQuality,
    TileSubscription,
)
from tessa_api.settings import Settings

TileMode = Literal["grid", "focus"]
Clock = Callable[[], float]

MIN_TILE_FPS = 1


class TileLimitExceededError(Exception):
    def __init__(self, limit: int, requested: int) -> None:
        super().__init__(f"{requested} tiles requested, at most {limit} allowed per connection")
        self.limit = limit
        self.requested = requested


def clamp_quality(quality: TileQuality) -> TileQuality:
    return TileQuality(
        max_fps=min(max(quality.max_fps, MIN_TILE_FPS), TILE_FPS_CEILING),
        quality=min(max(quality.quality, TILE_QUALITY_FLOOR), TILE_QUALITY_CEILING),
        max_width=min(max(quality.max_width, 1), TILE_WIDTH_CEILING),
    )


@dataclass(frozen=True, slots=True)
class Demand:
    max_fps: int
    quality: int
    max_width: int


@dataclass(frozen=True, slots=True)
class TilePolicy:
    max_tiles: int
    grid: TileQuality
    focus: TileQuality

    def quality_for(self, mode: TileMode) -> TileQuality:
        return self.grid if mode == "grid" else self.focus

    def idle_demand(self) -> Demand:
        return Demand(max_fps=0, quality=self.grid.quality, max_width=self.grid.max_width)

    def demand_for(self, modes: Iterable[TileMode]) -> Demand:
        qualities = [self.quality_for(mode) for mode in modes]
        if not qualities:
            return self.idle_demand()
        return Demand(
            max_fps=max(quality.max_fps for quality in qualities),
            quality=max(quality.quality for quality in qualities),
            max_width=max(quality.max_width for quality in qualities),
        )

    def limits(self) -> StreamLimits:
        return StreamLimits(max_tiles=self.max_tiles, grid=self.grid, focus=self.focus)


def tile_policy(settings: Settings) -> TilePolicy:
    return TilePolicy(
        max_tiles=settings.live_max_tiles_per_client,
        grid=clamp_quality(
            TileQuality(
                max_fps=settings.live_grid_max_fps,
                quality=settings.live_grid_quality,
                max_width=settings.live_grid_max_width,
            )
        ),
        focus=clamp_quality(
            TileQuality(
                max_fps=settings.live_focus_max_fps,
                quality=settings.live_focus_quality,
                max_width=settings.live_focus_max_width,
            )
        ),
    )


@dataclass(slots=True)
class TileFrame:
    run_id: UUID
    payload: TileFramePayload
    cached_text: str | None = field(default=None, repr=False)

    @property
    def session_id(self) -> UUID:
        return self.payload.browser_session_id

    @property
    def frame_seq(self) -> int:
        return self.payload.frame_seq

    def text(self) -> str:
        if self.cached_text is None:
            self.cached_text = TileFrameEvent(
                type="tile.frame",
                run_id=self.run_id,
                seq=None,
                ts=self.payload.captured_at,
                payload=self.payload,
            ).model_dump_json()
        return self.cached_text


@dataclass(slots=True)
class TileChannel:
    mode: TileMode
    interval_seconds: float
    slot: TileFrame | None = None
    unacked: deque[int] = field(default_factory=deque)
    highest_acked: int = -1
    highest_sent: int = -1
    last_sent_at: float | None = None
    offered: int = 0
    replaced: int = 0
    sent: int = 0

    def window_open(self) -> bool:
        return len(self.unacked) < TILE_MAX_UNACKED_FRAMES

    def newest_seq(self) -> int:
        held = -1 if self.slot is None else self.slot.frame_seq
        return max(self.highest_sent, held)

    def seconds_until_allowed(self, now: float) -> float:
        if self.last_sent_at is None:
            return 0.0
        return max(0.0, self.last_sent_at + self.interval_seconds - now)

    def retune(self, mode: TileMode, quality: TileQuality) -> None:
        self.mode = mode
        self.interval_seconds = 1 / quality.max_fps

    def acknowledge(self, frame_seq: int) -> None:
        self.highest_acked = max(self.highest_acked, frame_seq)
        while self.unacked and self.unacked[0] <= self.highest_acked:
            self.unacked.popleft()


class ClientTiles:
    def __init__(self, policy: TilePolicy, clock: Clock = time.monotonic) -> None:
        self._policy = policy
        self._clock = clock
        self._channels: dict[UUID, TileChannel] = {}
        self.explicit = False
        self.changed = asyncio.Event()

    def subscribed_ids(self) -> set[UUID]:
        return set(self._channels)

    def mode_of(self, session_id: UUID) -> TileMode | None:
        channel = self._channels.get(session_id)
        return None if channel is None else channel.mode

    def channel(self, session_id: UUID) -> TileChannel | None:
        return self._channels.get(session_id)

    def replace_subscription(self, tiles: Sequence[TileSubscription]) -> set[UUID]:
        wanted = {tile.browser_session_id: tile.mode for tile in tiles}
        if len(wanted) > self._policy.max_tiles:
            raise TileLimitExceededError(self._policy.max_tiles, len(wanted))
        affected = set(self._channels) | set(wanted)
        self.explicit = True
        for session_id in set(self._channels) - set(wanted):
            del self._channels[session_id]
        for session_id, mode in wanted.items():
            quality = self._policy.quality_for(mode)
            channel = self._channels.get(session_id)
            if channel is None:
                self._channels[session_id] = TileChannel(mode, 1 / quality.max_fps)
            else:
                channel.retune(mode, quality)
        self.changed.set()
        return affected

    def offer(self, frame: TileFrame, mode: TileMode) -> bool:
        channel = self._channels.get(frame.session_id)
        if channel is None:
            if self.explicit:
                return False
            channel = TileChannel(mode, 1 / self._policy.quality_for(mode).max_fps)
            self._channels[frame.session_id] = channel
        if frame.frame_seq <= channel.newest_seq():
            return False
        channel.offered += 1
        if channel.slot is not None:
            channel.replaced += 1
        channel.slot = frame
        self.changed.set()
        return True

    def acknowledge(self, session_id: UUID, frame_seq: int) -> None:
        channel = self._channels.get(session_id)
        if channel is None:
            return
        channel.acknowledge(frame_seq)
        self.changed.set()

    def pop_ready(self) -> list[TileFrame]:
        now = self._clock()
        ready: list[TileFrame] = []
        for channel in self._channels.values():
            frame = channel.slot
            if frame is None or not channel.window_open():
                continue
            if channel.seconds_until_allowed(now) > 0:
                continue
            channel.slot = None
            channel.unacked.append(frame.frame_seq)
            channel.highest_sent = max(channel.highest_sent, frame.frame_seq)
            channel.last_sent_at = now
            channel.sent += 1
            ready.append(frame)
        return ready

    def seconds_until_ready(self) -> float | None:
        now = self._clock()
        waits = [
            channel.seconds_until_allowed(now)
            for channel in self._channels.values()
            if channel.slot is not None and channel.window_open()
        ]
        return min(waits) if waits else None
