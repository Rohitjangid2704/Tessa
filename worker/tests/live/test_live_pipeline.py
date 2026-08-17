from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

import pytest

from tessa_api.ids import new_id
from tessa_api.schemas.scenario import BrowserStep
from tessa_worker.adapters.browser import BrowserAdapter, BrowserRuntime
from tessa_worker.live.frame_pump import FRAME_BUDGET_BYTES, Phase
from tessa_worker.live.uplink import FrameUplink
from tessa_worker.settings import WorkerSettings
from tests.browser_site.site import TestSite
from tests.live.conftest import browser_context
from tests.live.live_stack import (
    LiveApi,
    collect_frames,
    connected_uplink,
    subscribe_message,
)
from tests.live.support import eventually

pytestmark = [pytest.mark.browser, pytest.mark.integration]

GRID_FPS = 4
FOCUS_FPS = 10
GRID_WIDTH = 640
FOCUS_WIDTH = 1280
WINDOW_SECONDS = 3.0
PAGE_LOAD_PATIENCE_SECONDS = 30.0


@dataclass
class Pipeline:
    api: LiveApi
    runtime: BrowserRuntime
    uplink: FrameUplink
    adapter: BrowserAdapter
    run_id: UUID
    session_id: UUID


def goto(path: str) -> BrowserStep:
    return BrowserStep.model_validate({"adapter": "browser", "action": "goto", "url": path})


@pytest.fixture
async def pipeline(
    live_api: LiveApi, worker_settings: WorkerSettings, site: TestSite, tmp_path: Path
) -> AsyncIterator[Pipeline]:
    settings = worker_settings.model_copy(
        update={"data_dir": tmp_path / "data", "browser_max_contexts": 2, "browser_headless": True}
    )
    uplink = await connected_uplink(settings, live_api)
    runtime = BrowserRuntime(settings, uplink)
    await runtime.start()
    run_id, session_id = new_id(), new_id()
    await live_api.announce_session(run_id, session_id)
    adapter = await runtime.open_adapter(browser_context(site), session_id)
    yield Pipeline(live_api, runtime, uplink, adapter, run_id, session_id)
    await adapter.close()
    await runtime.stop()


async def test_frames_of_a_real_page_reach_a_subscribed_client_and_stop_when_it_unsubscribes(
    pipeline: Pipeline,
) -> None:
    api, adapter, session_id = pipeline.api, pipeline.adapter, pipeline.session_id
    await adapter.drive(goto("/animated"))
    stream = await api.open_stream(pipeline.run_id)
    async with stream:
        await stream.send(subscribe_message(session_id, "grid"))
        frames = await collect_frames(stream, session_id, WINDOW_SECONDS + 2)
        assert len(frames) >= 2
        assert [frame.payload.frame_seq for frame in frames] == sorted(
            {frame.payload.frame_seq for frame in frames}
        )
        for frame in frames:
            assert frame.payload.mime == "image/jpeg"
            assert (frame.payload.page_url or "").endswith("/animated")
            assert frame.width <= GRID_WIDTH
            assert frame.size_bytes <= FRAME_BUDGET_BYTES
        assert len(frames) <= GRID_FPS * (WINDOW_SECONDS + 2) + 3
        assert adapter.pump is not None
        assert adapter.pump.stats.forwarded >= len(frames)

        await stream.send(subscribe_message(session_id, "none"))
        await eventually(lambda: adapter.pump is not None and adapter.pump.phase is Phase.stopped)
        await collect_frames(stream, session_id, 0.6)
        assert await collect_frames(stream, session_id, 1.5) == []

        await stream.send(subscribe_message(session_id, "focus"))
        focused = await collect_frames(stream, session_id, WINDOW_SECONDS + 2)
        assert len(focused) >= 2
        assert max(frame.width for frame in focused) > GRID_WIDTH
        assert max(frame.width for frame in focused) <= FOCUS_WIDTH
        assert len(focused) <= FOCUS_FPS * (WINDOW_SECONDS + 2) + 3
        assert len(focused) > len(frames) or len(focused) >= GRID_FPS


async def test_a_still_page_is_shown_once_and_then_costs_nothing(pipeline: Pipeline) -> None:
    api, adapter, session_id = pipeline.api, pipeline.adapter, pipeline.session_id
    await adapter.drive(goto("/static"))
    stream = await api.open_stream(pipeline.run_id)
    async with stream:
        await stream.send(subscribe_message(session_id, "grid"))
        first = await collect_frames(stream, session_id, 3.0)
        assert len(first) >= 1
        assert (first[0].payload.page_url or "").endswith("/static")
        assert len(first) <= 3


async def test_a_late_subscriber_sees_a_page_that_has_not_changed_since(
    pipeline: Pipeline,
) -> None:
    api, adapter, session_id = pipeline.api, pipeline.adapter, pipeline.session_id
    await adapter.drive(goto("/static"))
    first_stream = await api.open_stream(pipeline.run_id)
    async with first_stream:
        await first_stream.send(subscribe_message(session_id, "grid"))
        assert await collect_frames(first_stream, session_id, 3.0)
    second_stream = await api.open_stream(pipeline.run_id)
    async with second_stream:
        await second_stream.send(subscribe_message(session_id, "grid"))
        late = await collect_frames(second_stream, session_id, 6.0)
    assert len(late) >= 1
    assert (late[0].payload.page_url or "").endswith("/static")


async def test_a_page_of_pure_noise_is_cut_to_the_frame_budget_by_shrinking_the_width(
    pipeline: Pipeline,
) -> None:
    api, adapter, session_id = pipeline.api, pipeline.adapter, pipeline.session_id
    await adapter.drive(goto("/noise"))
    stream = await api.open_stream(pipeline.run_id)
    async with stream:
        await stream.send(subscribe_message(session_id, "focus"))
        frames = await collect_frames(stream, session_id, 10.0)
    assert len(frames) >= 3
    largest = max(frames, key=lambda frame: frame.size_bytes)
    assert largest.size_bytes > FRAME_BUDGET_BYTES
    assert largest.width > GRID_WIDTH
    assert adapter.pump is not None
    assert adapter.pump.stats.degrades >= 1
    assert adapter.pump.stats.oversize_frames >= 1
    last = frames[-1]
    assert last.size_bytes <= FRAME_BUDGET_BYTES
    assert 320 <= last.width < largest.width
    after_largest = frames[frames.index(largest) :]
    widths = [frame.width for frame in after_largest]
    assert widths == sorted(widths, reverse=True)


async def test_closing_the_adapter_ends_the_frames_and_the_demand_for_its_tile(
    pipeline: Pipeline,
) -> None:
    api, adapter, session_id = pipeline.api, pipeline.adapter, pipeline.session_id
    await adapter.drive(goto("/animated"))
    stream = await api.open_stream(pipeline.run_id)
    async with stream:
        await stream.send(subscribe_message(session_id, "grid"))
        assert await collect_frames(stream, session_id, 3.0)
        await adapter.close()
        await collect_frames(stream, session_id, 0.8)
        assert await collect_frames(stream, session_id, 1.5) == []
        assert adapter.pump is not None
        assert adapter.pump.phase is Phase.stopped
        assert api.app.state.hub.tiles.is_registered(session_id)
        await api.end_session(pipeline.run_id, session_id)
        assert not api.app.state.hub.tiles.is_registered(session_id)


async def test_the_uplink_survives_the_api_dropping_its_socket(pipeline: Pipeline) -> None:
    api, adapter, session_id = pipeline.api, pipeline.adapter, pipeline.session_id
    await adapter.drive(goto("/animated"))
    stream = await api.open_stream(pipeline.run_id)
    async with stream:
        await stream.send(subscribe_message(session_id, "grid"))
        assert await collect_frames(stream, session_id, 3.0)
        api.app.state.hub.tiles.shutdown()
        await eventually(lambda: pipeline.uplink.connections >= 2 and pipeline.uplink.connected)
        await stream.send(subscribe_message(session_id, "none"))
        await stream.send(subscribe_message(session_id, "grid"))
        again = await collect_frames(stream, session_id, 5.0)
    assert len(again) >= 1
