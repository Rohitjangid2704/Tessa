import asyncio
import json
import os
import statistics
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from uuid import UUID

import pytest

from tessa_api.ids import new_id
from tessa_api.schemas.scenario import BrowserStep
from tessa_worker.adapters.browser import BrowserAdapter, BrowserRuntime
from tessa_worker.live.frame_pump import FRAME_BUDGET_BYTES, PumpStats
from tessa_worker.live.uplink import FrameUplink
from tessa_worker.settings import WorkerSettings
from tests.browser_site.site import TestSite
from tests.live.conftest import browser_context
from tests.live.live_stack import (
    ExternalApi,
    ReceivedFrame,
    collect_tile_frames,
    connected_uplink,
    subscribe_many,
)
from tests.live.process_support import cpu_seconds_of, pids_with_command_line

pytestmark = [pytest.mark.browser, pytest.mark.integration]

CONTEXTS = 8
GRID_FPS = 4
FOCUS_FPS = 10
SETTLE_SECONDS = 2.0
MEASURE_SETTLE_SECONDS = 6.0
DRAIN_SECONDS = 1.5
SECONDS_ENV = "LIVE_MEASURE_SECONDS"
OUTPUT_ENV = "LIVE_MEASURE_OUTPUT"
QUICK_SECONDS = 6.0
RATE_SLACK_FRAMES = 4


@dataclass
class PhaseReport:
    mode: str
    seconds: float
    tiles_with_frames: int
    frames_total: int
    fps_total: float
    fps_per_tile_min: float
    fps_per_tile_mean: float
    fps_per_tile_max: float
    kib_per_frame_mean: float
    mib_per_second: float
    width_max: int
    cdp_frames_received: int
    cdp_frames_dropped_by_rate_gate: int
    frames_forwarded_to_uplink: int
    frames_superseded_in_uplink: int
    frames_sent_to_api: int
    frames_lost_between_api_and_client: int
    chromium_cpu_percent_of_one_core: float | None
    api_cpu_percent_of_one_core: float | None
    worker_and_client_cpu_percent_of_one_core: float


@dataclass
class Counters:
    pump: PumpStats
    sent: int
    superseded: int


def total_pump_stats(adapters: list[BrowserAdapter]) -> PumpStats:
    total = PumpStats()
    for adapter in adapters:
        assert adapter.pump is not None
        stats = adapter.pump.stats
        total.received += stats.received
        total.forwarded += stats.forwarded
        total.rate_dropped += stats.rate_dropped
    return total


def snapshot(adapters: list[BrowserAdapter], uplink: FrameUplink) -> Counters:
    return Counters(total_pump_stats(adapters), uplink.frames_sent, uplink.frames_superseded)


def write_report(path: Path, reports: list[PhaseReport]) -> None:
    path.write_text(json.dumps([asdict(report) for report in reports], indent=2), encoding="utf-8")


def goto(path: str) -> BrowserStep:
    return BrowserStep.model_validate({"adapter": "browser", "action": "goto", "url": path})


def cpu_percent(before: float | None, after: float | None, seconds: float) -> float | None:
    if before is None or after is None:
        return None
    return round(100 * (after - before) / seconds, 1)


def chromium_cpu(fragment: str, enabled: bool) -> float | None:
    return cpu_seconds_of(pids_with_command_line(fragment)) if enabled else None


def api_cpu(api: ExternalApi, enabled: bool) -> float | None:
    return cpu_seconds_of([api.pid]) if enabled else None


def summarise(
    mode: str,
    seconds: float,
    frames: dict[UUID, list[ReceivedFrame]],
    sessions: list[UUID],
    before: Counters,
    after: Counters,
    cpu: dict[str, float | None],
) -> PhaseReport:
    counts = [len(frames.get(session, [])) for session in sessions]
    every = [frame for items in frames.values() for frame in items]
    received = len(every)
    sent = after.sent - before.sent
    sizes = [frame.size_bytes for frame in every]
    return PhaseReport(
        mode=mode,
        seconds=round(seconds, 2),
        tiles_with_frames=sum(1 for count in counts if count > 0),
        frames_total=received,
        fps_total=round(received / seconds, 2),
        fps_per_tile_min=round(min(counts) / seconds, 2),
        fps_per_tile_mean=round(statistics.mean(counts) / seconds, 2),
        fps_per_tile_max=round(max(counts) / seconds, 2),
        kib_per_frame_mean=round(statistics.mean(sizes) / 1024, 1) if sizes else 0.0,
        mib_per_second=round(sum(sizes) / seconds / 1024 / 1024, 2),
        width_max=max((frame.width for frame in every), default=0),
        cdp_frames_received=after.pump.received - before.pump.received,
        cdp_frames_dropped_by_rate_gate=after.pump.rate_dropped - before.pump.rate_dropped,
        frames_forwarded_to_uplink=after.pump.forwarded - before.pump.forwarded,
        frames_superseded_in_uplink=after.superseded - before.superseded,
        frames_sent_to_api=sent,
        frames_lost_between_api_and_client=max(0, sent - received),
        chromium_cpu_percent_of_one_core=cpu_percent(
            cpu["chromium_before"], cpu["chromium_after"], seconds
        ),
        api_cpu_percent_of_one_core=cpu_percent(cpu["api_before"], cpu["api_after"], seconds),
        worker_and_client_cpu_percent_of_one_core=cpu_percent(
            cpu["process_before"], cpu["process_after"], seconds
        )
        or 0.0,
    )


async def open_all(
    runtime: BrowserRuntime, site: TestSite, sessions: list[UUID]
) -> list[BrowserAdapter]:
    adapters = await asyncio.gather(
        *(runtime.open_adapter(browser_context(site), session) for session in sessions)
    )
    await asyncio.gather(*(adapter.drive(goto("/animated")) for adapter in adapters))
    return list(adapters)


async def test_eight_concurrent_contexts_stream_within_the_tile_limits_and_the_frame_budget(
    external_api: ExternalApi,
    worker_settings: WorkerSettings,
    site: TestSite,
    tmp_path: Path,
) -> None:
    measure = SECONDS_ENV in os.environ
    seconds = float(os.environ.get(SECONDS_ENV, QUICK_SECONDS))
    settle = MEASURE_SETTLE_SECONDS if measure else SETTLE_SECONDS
    drain = DRAIN_SECONDS
    settings = worker_settings.model_copy(
        update={
            "data_dir": tmp_path / "data",
            "browser_max_contexts": CONTEXTS,
            "browser_headless": True,
        }
    )
    uplink = await connected_uplink(settings, external_api)
    runtime = BrowserRuntime(settings, uplink)
    await runtime.start()
    run_id = new_id()
    sessions = [new_id() for _ in range(CONTEXTS)]
    adapters: list[BrowserAdapter] = []
    reports: list[PhaseReport] = []
    try:
        for session in sessions:
            await external_api.announce_session(run_id, session)
        adapters = await open_all(runtime, site, sessions)
        assert runtime.host.active_contexts == CONTEXTS
        stream = await external_api.open_stream(run_id)
        async with stream:
            for mode in ("grid", "focus", "none"):
                await stream.send(subscribe_many(sessions if mode != "none" else [], mode))
                await collect_tile_frames(stream, drain if mode == "none" else settle)
                fragment = tmp_path.name
                cpu: dict[str, float | None] = {
                    "chromium_before": await asyncio.to_thread(chromium_cpu, fragment, measure),
                    "api_before": await asyncio.to_thread(api_cpu, external_api, measure),
                    "process_before": time.process_time(),
                }
                before = snapshot(adapters, uplink)
                started = time.monotonic()
                frames = await collect_tile_frames(stream, seconds)
                elapsed = time.monotonic() - started
                after = snapshot(adapters, uplink)
                cpu.update(
                    {
                        "chromium_after": await asyncio.to_thread(chromium_cpu, fragment, measure),
                        "api_after": await asyncio.to_thread(api_cpu, external_api, measure),
                        "process_after": time.process_time(),
                    }
                )
                reports.append(summarise(mode, elapsed, frames, sessions, before, after, cpu))
    finally:
        for adapter in adapters:
            await adapter.close()
        await runtime.stop()

    print(json.dumps([asdict(report) for report in reports], indent=2))
    output = os.environ.get(OUTPUT_ENV)
    if output:
        await asyncio.to_thread(write_report, Path(output), reports)

    grid, focus, idle = reports
    assert grid.tiles_with_frames == CONTEXTS
    assert grid.fps_per_tile_max <= GRID_FPS + RATE_SLACK_FRAMES / seconds
    assert grid.fps_total <= CONTEXTS * GRID_FPS + CONTEXTS * RATE_SLACK_FRAMES / seconds
    assert grid.width_max <= 640
    assert focus.tiles_with_frames == CONTEXTS
    assert focus.fps_per_tile_max <= FOCUS_FPS + RATE_SLACK_FRAMES / seconds
    assert focus.width_max <= 1280
    assert focus.fps_total >= grid.fps_total * 0.5
    assert idle.frames_total == 0
    assert idle.cdp_frames_received <= CONTEXTS * 2
    assert grid.kib_per_frame_mean * 1024 <= FRAME_BUDGET_BYTES
    assert pids_with_command_line(tmp_path.name) == []
