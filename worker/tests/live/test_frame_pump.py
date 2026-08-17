import asyncio
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from uuid import UUID

import pytest

from tessa_api.ids import new_id
from tessa_worker.live.frame_pump import (
    FRAME_BUDGET_BYTES,
    FramePump,
    Phase,
    PumpLimits,
    decoded_size,
    every_nth_frame,
    jpeg_dimensions,
)
from tessa_worker.live.uplink import PAUSED, TileDemand
from tessa_worker.settings import WorkerSettings
from tests.live.support import FakeCdp, FakeClock, FakeUplink, eventually, fake_jpeg_b64

GRID = TileDemand(max_fps=4, quality=60, max_width=640)
FOCUS = TileDemand(max_fps=10, quality=75, max_width=1280)
LIMITS = PumpLimits(max_fps=15, quality=90, max_width=1920)
SETTLE = 0.05
HUGE = fake_jpeg_b64(1280, 720, padding_bytes=FRAME_BUDGET_BYTES + 5000)


@dataclass
class Rig:
    pump: FramePump
    cdp: FakeCdp
    uplink: FakeUplink
    clock: FakeClock
    session_id: UUID
    log: list[str]

    async def steady(self) -> None:
        await eventually(lambda: self.pump.phase is Phase.steady)

    async def start_streaming(self, demand: TileDemand = GRID) -> None:
        self.uplink.set_demand(self.session_id, demand)
        await eventually(lambda: len(self.cdp.starts()) >= 1)
        await self.cdp.emit_frame()
        await self.steady()

    async def burst(self, frames: int = 14, spacing: float = 0.03) -> None:
        for _ in range(frames):
            self.clock.advance(spacing)
            await self.cdp.emit_frame()


def more_starts_than(rig: Rig, count: int) -> Callable[[], bool]:
    return lambda: len(rig.cdp.starts()) > count


def build_rig(settle_seconds: float = 60.0, limits: PumpLimits = LIMITS) -> Rig:
    log: list[str] = []
    cdp = FakeCdp(log)
    uplink = FakeUplink(log)
    clock = FakeClock()
    session_id = new_id()
    pump = FramePump(
        session_id,
        cdp,
        uplink,
        lambda: "http://app.test/chat",
        limits,
        clock=clock,
        settle_seconds=settle_seconds,
    )
    pump.start()
    return Rig(pump, cdp, uplink, clock, session_id, log)


@pytest.fixture
async def rig() -> AsyncIterator[Rig]:
    built = build_rig()
    yield built
    await built.pump.close()


@pytest.fixture
async def quick() -> AsyncIterator[Rig]:
    built = build_rig(settle_seconds=SETTLE)
    yield built
    await built.pump.close()


def test_every_nth_frame_oversamples_the_source_twice() -> None:
    assert every_nth_frame(4) == 7
    assert every_nth_frame(10) == 3
    assert every_nth_frame(15) == 2
    assert every_nth_frame(1) == 30


def test_the_size_of_a_frame_is_its_decoded_length() -> None:
    assert decoded_size("AAAA") == 3
    assert decoded_size("AAA=") == 2
    assert decoded_size("AA==") == 1


def test_jpeg_dimensions_come_from_the_frame_header() -> None:
    assert jpeg_dimensions(fake_jpeg_b64(640, 360)) == (640, 360)
    assert jpeg_dimensions(fake_jpeg_b64(1920, 1080, padding_bytes=5000)) == (1920, 1080)


@pytest.mark.parametrize("data", ["", "not base64 at all!", "AAAA", "/9j/"])
def test_jpeg_dimensions_are_unknown_for_anything_that_is_not_a_complete_jpeg_header(
    data: str,
) -> None:
    assert jpeg_dimensions(data) is None


def test_the_limits_are_the_ceilings_of_both_modes(worker_settings: WorkerSettings) -> None:
    limits = PumpLimits.from_settings(worker_settings)
    assert limits == PumpLimits(max_fps=10, quality=75, max_width=1280)


async def test_nothing_is_captured_until_somebody_asks(rig: Rig) -> None:
    await asyncio.sleep(0.1)
    assert rig.cdp.calls == []
    assert rig.pump.phase is Phase.stopped
    assert rig.pump.demand.max_fps == 0


async def test_a_demand_starts_with_a_probe_that_shows_the_page_at_once(rig: Rig) -> None:
    rig.uplink.set_demand(rig.session_id, GRID)
    await eventually(lambda: rig.cdp.starts() != [])
    assert rig.cdp.starts() == [
        {"format": "jpeg", "quality": 60, "maxWidth": 640, "everyNthFrame": 1}
    ]
    assert rig.pump.phase is Phase.probing


async def test_a_page_with_little_going_on_keeps_every_frame_it_produces(rig: Rig) -> None:
    await rig.start_streaming()
    assert [method for method in rig.cdp.methods() if method != "Page.screencastFrameAck"] == [
        "Page.startScreencast"
    ]
    assert rig.pump.stats.restarts == 0
    assert [payload.frame_seq for payload in rig.uplink.payloads] == [0]


async def test_a_burst_of_frames_moves_to_sampled_capture(rig: Rig) -> None:
    await rig.start_streaming()
    await rig.burst()
    await eventually(lambda: len(rig.cdp.starts()) == 2)
    assert rig.cdp.starts()[1] == {
        "format": "jpeg",
        "quality": 60,
        "maxWidth": 640,
        "everyNthFrame": 7,
    }
    assert rig.cdp.methods().count("Page.stopScreencast") == 1
    assert rig.pump.stats.restarts == 1
    assert rig.pump.phase is Phase.steady


async def test_a_frame_is_acknowledged_only_after_it_was_handed_to_the_uplink(rig: Rig) -> None:
    rig.uplink.set_demand(rig.session_id, GRID)
    await eventually(lambda: rig.cdp.starts() != [])
    rig.uplink.hold = asyncio.Event()
    emitting = asyncio.create_task(rig.cdp.emit_frame())
    await eventually(lambda: "submit:0" in rig.log)
    assert rig.cdp.acks() == []
    rig.uplink.hold.set()
    await emitting
    assert rig.log.index("submit:0") < rig.log.index("cdp:Page.screencastFrameAck")
    assert rig.cdp.acks()[0]["sessionId"] == 1


async def test_the_payload_carries_the_page_and_the_capture_time(rig: Rig) -> None:
    rig.uplink.set_demand(rig.session_id, GRID)
    await eventually(lambda: rig.cdp.starts() != [])
    await rig.cdp.emit_frame(fake_jpeg_b64(640, 360), timestamp=1791186427.5)
    payload = rig.uplink.payloads[0]
    assert payload.browser_session_id == rig.session_id
    assert (payload.width, payload.height) == (640, 360)
    assert payload.mime == "image/jpeg"
    assert payload.page_url == "http://app.test/chat"
    assert payload.captured_at.isoformat().startswith("2026-10-05T")


async def test_frames_that_arrive_too_fast_are_dropped_but_acknowledged(rig: Rig) -> None:
    await rig.start_streaming()
    first_acks = len(rig.cdp.acks())
    rig.clock.advance(0.1)
    await rig.cdp.emit_frame()
    assert len(rig.uplink.payloads) == 1
    assert rig.pump.stats.rate_dropped == 1
    assert len(rig.cdp.acks()) == first_acks + 1
    rig.clock.advance(0.2)
    await rig.cdp.emit_frame()
    assert [payload.frame_seq for payload in rig.uplink.payloads] == [0, 1]


async def test_a_higher_demand_probes_again_with_the_new_settings(rig: Rig) -> None:
    await rig.start_streaming(GRID)
    rig.uplink.set_demand(rig.session_id, FOCUS)
    await eventually(lambda: len(rig.cdp.starts()) == 2)
    assert rig.cdp.starts()[1] == {
        "format": "jpeg",
        "quality": 75,
        "maxWidth": 1280,
        "everyNthFrame": 1,
    }
    assert rig.cdp.methods().count("Page.stopScreencast") == 1
    await rig.cdp.emit_frame()
    await rig.steady()


async def test_the_same_demand_again_does_nothing(rig: Rig) -> None:
    await rig.start_streaming()
    calls = len(rig.cdp.calls)
    rig.uplink.set_demand(rig.session_id, GRID)
    await asyncio.sleep(0.1)
    assert len(rig.cdp.calls) == calls


async def test_no_demand_stops_the_screencast_and_late_frames_are_not_forwarded(rig: Rig) -> None:
    await rig.start_streaming()
    rig.uplink.set_demand(rig.session_id, PAUSED)
    await eventually(lambda: rig.pump.phase is Phase.stopped)
    assert rig.cdp.methods()[-1] == "Page.stopScreencast"
    forwarded = len(rig.uplink.payloads)
    rig.clock.advance(5)
    await rig.cdp.emit_frame()
    assert len(rig.uplink.payloads) == forwarded
    assert rig.cdp.acks()[-1]["sessionId"] == 2


async def test_a_resumed_demand_starts_again_and_the_frame_numbers_keep_counting(rig: Rig) -> None:
    await rig.start_streaming()
    rig.uplink.set_demand(rig.session_id, PAUSED)
    await eventually(lambda: rig.pump.phase is Phase.stopped)
    rig.uplink.set_demand(rig.session_id, GRID)
    await eventually(lambda: rig.pump.phase is Phase.probing)
    await rig.cdp.emit_frame()
    await rig.steady()
    assert [payload.frame_seq for payload in rig.uplink.payloads] == [0, 1]


async def test_the_demand_is_clamped_to_the_worker_limits() -> None:
    small = build_rig(limits=PumpLimits(max_fps=5, quality=70, max_width=800))
    try:
        small.uplink.set_demand(small.session_id, TileDemand(15, 90, 1920))
        await eventually(lambda: small.cdp.starts() != [])
        assert small.cdp.starts()[0]["quality"] == 70
        assert small.cdp.starts()[0]["maxWidth"] == 800
        assert small.pump.demand.max_fps == 5
    finally:
        await small.pump.close()


async def test_an_oversized_frame_first_reduces_the_width_and_probes_again(rig: Rig) -> None:
    await rig.start_streaming(FOCUS)
    rig.clock.advance(1)
    await rig.cdp.emit_frame(HUGE)
    await eventually(lambda: rig.pump.stats.degrades == 1)
    await eventually(lambda: rig.cdp.starts()[-1]["maxWidth"] == 960)
    assert rig.cdp.starts()[-1]["quality"] == 75
    assert rig.pump.stats.oversize_frames == 1


async def test_the_width_shrinks_to_its_floor_before_the_quality_drops(rig: Rig) -> None:
    await rig.start_streaming(FOCUS)
    seen: list[tuple[int, int]] = []
    for _ in range(12):
        starts_before = len(rig.cdp.starts())
        degrades_before = rig.pump.stats.degrades
        rig.clock.advance(1)
        await rig.cdp.emit_frame(HUGE)
        if rig.pump.stats.degrades == degrades_before:
            break
        await eventually(more_starts_than(rig, starts_before))
        await rig.cdp.emit_frame()
        await rig.steady()
        latest = rig.cdp.starts()[-1]
        seen.append((latest["maxWidth"], latest["quality"]))
    widths = [width for width, _ in seen]
    qualities = [quality for _, quality in seen]
    assert widths[0] == 960
    assert widths == sorted(widths, reverse=True)
    assert min(widths) >= 320
    assert qualities == sorted(qualities, reverse=True)
    assert min(qualities) >= 30
    assert qualities[-1] < 75
    assert all(width < 430 for width, quality in seen if quality < 75)


async def test_a_new_demand_forgets_the_degradation(rig: Rig) -> None:
    await rig.start_streaming(FOCUS)
    rig.clock.advance(1)
    await rig.cdp.emit_frame(HUGE)
    await eventually(lambda: rig.pump.stats.degrades == 1)
    rig.uplink.set_demand(rig.session_id, GRID)
    await eventually(lambda: rig.cdp.starts()[-1]["maxWidth"] == 640)


async def test_a_frame_dropped_by_the_rate_gate_is_made_up_by_a_fresh_capture(quick: Rig) -> None:
    await quick.start_streaming()
    quick.clock.advance(0.1)
    await quick.cdp.emit_frame()
    await eventually(lambda: quick.pump.stats.refreshes == 1)
    await eventually(lambda: len(quick.cdp.starts()) == 2)
    assert quick.cdp.starts()[1]["everyNthFrame"] == 1
    await quick.cdp.emit_frame()
    await quick.steady()
    assert [payload.frame_seq for payload in quick.uplink.payloads] == [0, 1]


async def test_frames_that_were_all_forwarded_need_no_fresh_capture(quick: Rig) -> None:
    await quick.start_streaming()
    quick.clock.advance(1)
    await quick.cdp.emit_frame()
    await asyncio.sleep(SETTLE * 6)
    assert quick.pump.stats.refreshes == 0
    assert len(quick.cdp.starts()) == 1


async def test_the_end_of_a_burst_is_captured_again_and_sampling_goes_back_to_every_frame(
    quick: Rig,
) -> None:
    await quick.start_streaming()
    await quick.burst()
    await eventually(lambda: quick.pump.stats.restarts == 1)
    await eventually(lambda: quick.pump.stats.refreshes == 1)
    await eventually(lambda: quick.cdp.starts()[-1]["everyNthFrame"] == 1)
    assert len(quick.cdp.starts()) == 3
    await quick.cdp.emit_frame()
    await quick.steady()
    starts = len(quick.cdp.starts())
    await asyncio.sleep(SETTLE * 6)
    assert quick.pump.stats.refreshes == 1
    assert len(quick.cdp.starts()) == starts


async def test_closing_stops_the_screencast_detaches_and_forgets_the_session(rig: Rig) -> None:
    await rig.start_streaming()
    await rig.pump.close()
    assert rig.cdp.methods()[-1] == "Page.stopScreencast"
    assert rig.cdp.detached is True
    assert rig.uplink.forgotten == [rig.session_id]
    assert rig.uplink.listeners == {}
    forwarded = len(rig.uplink.payloads)
    rig.clock.advance(5)
    await rig.cdp.emit_frame()
    assert len(rig.uplink.payloads) == forwarded


async def test_closing_twice_is_harmless(rig: Rig) -> None:
    await rig.pump.close()
    await rig.pump.close()
    assert rig.uplink.forgotten == [rig.session_id]


async def test_a_page_that_is_gone_ends_the_control_loop_quietly(rig: Rig) -> None:
    rig.cdp.failing.add("Page.startScreencast")
    rig.uplink.set_demand(rig.session_id, GRID)
    await eventually(lambda: rig.cdp.failures == ["Page.startScreencast"])
    await eventually(lambda: rig.pump.phase is Phase.stopped)
    rig.uplink.set_demand(rig.session_id, FOCUS)
    await asyncio.sleep(0.1)
    assert rig.cdp.failures == ["Page.startScreencast"]


async def test_a_failing_acknowledgement_is_counted_and_never_raised(rig: Rig) -> None:
    rig.uplink.set_demand(rig.session_id, GRID)
    await eventually(lambda: rig.cdp.starts() != [])
    rig.cdp.failing.add("Page.screencastFrameAck")
    await rig.cdp.emit_frame()
    assert rig.pump.stats.ack_failures == 1


async def test_a_frame_without_a_readable_header_uses_the_page_size(rig: Rig) -> None:
    rig.uplink.set_demand(rig.session_id, GRID)
    await eventually(lambda: rig.cdp.starts() != [])
    await rig.cdp.emit_frame("AAAA")
    payload = rig.uplink.payloads[0]
    assert (payload.width, payload.height) == (1280, 720)
