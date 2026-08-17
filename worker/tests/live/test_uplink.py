import asyncio
from collections.abc import AsyncIterator
from uuid import UUID

import pytest

from tessa_api.ids import new_id
from tessa_api.schemas.events import FrameIngestMessage, TileFramePayload
from tessa_worker.live.uplink import (
    BACKOFF_JITTER,
    BACKOFF_SECONDS,
    PAUSED,
    FrameUplink,
    TileDemand,
    backoff_delay,
    frames_url,
)
from tessa_worker.settings import WorkerSettings
from tests.live.fake_api import FakeFrameApi
from tests.live.support import eventually, fake_jpeg_b64

FAST_BACKOFF = (0.05, 0.05, 0.1)
SERVICE_KEY = "dev-only-uplink-service-key-0123456789abcdef"


def payload_for(session_id: UUID, frame_seq: int) -> TileFramePayload:
    return TileFramePayload.model_validate(
        {
            "browser_session_id": session_id,
            "frame_seq": frame_seq,
            "mime": "image/jpeg",
            "width": 640,
            "height": 360,
            "data_b64": fake_jpeg_b64(),
            "page_url": "http://app.test/",
            "captured_at": "2026-10-05T09:00:00.000Z",
        }
    )


@pytest.fixture
async def api() -> AsyncIterator[FakeFrameApi]:
    fake = FakeFrameApi(SERVICE_KEY)
    await fake.start()
    yield fake
    await fake.stop()


def settings_for(
    worker_settings: WorkerSettings, api: FakeFrameApi, key: str = SERVICE_KEY
) -> WorkerSettings:
    return worker_settings.model_copy(
        update={"api_internal_url": api.url, "service_key": type(worker_settings.service_key)(key)}
    )


@pytest.fixture
async def uplink(worker_settings: WorkerSettings, api: FakeFrameApi) -> AsyncIterator[FrameUplink]:
    connection = FrameUplink(settings_for(worker_settings, api), backoff=FAST_BACKOFF)
    await connection.start()
    await connection.wait_connected(10)
    yield connection
    await connection.stop()


def test_the_url_is_the_frames_endpoint_of_the_api_over_a_websocket() -> None:
    assert frames_url("http://127.0.0.1:8000") == "ws://127.0.0.1:8000/internal/v1/frames"
    assert frames_url("https://api.example.com/") == "wss://api.example.com/internal/v1/frames"


def test_the_backoff_grows_to_its_cap_and_stays_there() -> None:
    delays = [backoff_delay(attempt, jitter=lambda: 0.5) for attempt in range(8)]
    assert delays[: len(BACKOFF_SECONDS)] == list(BACKOFF_SECONDS)
    assert set(delays[len(BACKOFF_SECONDS) :]) == {BACKOFF_SECONDS[-1]}


def test_the_backoff_is_jittered_within_its_bounds() -> None:
    low = backoff_delay(2, jitter=lambda: 0.0)
    high = backoff_delay(2, jitter=lambda: 1.0)
    assert low == pytest.approx(BACKOFF_SECONDS[2] * (1 - BACKOFF_JITTER))
    assert high == pytest.approx(BACKOFF_SECONDS[2] * (1 + BACKOFF_JITTER))


async def test_the_uplink_opens_one_socket_with_the_service_key(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    assert uplink.connected is True
    assert api.handshakes == 1
    assert len(api.connections) == 1


async def test_a_submitted_frame_reaches_the_api_as_a_valid_frame_message(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    session_id = new_id()
    await uplink.submit(payload_for(session_id, 3))
    await eventually(lambda: len(api.frames) == 1)
    message = FrameIngestMessage.model_validate(api.frames[0])
    assert message.payload.browser_session_id == session_id
    assert message.payload.frame_seq == 3
    assert uplink.frames_sent == 1


async def test_only_the_newest_frame_of_a_tile_is_sent_when_several_wait(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    session_id = new_id()
    older = asyncio.create_task(uplink.submit(payload_for(session_id, 1)))
    newer = asyncio.create_task(uplink.submit(payload_for(session_id, 2)))
    await asyncio.wait_for(asyncio.gather(older, newer), 10)
    await eventually(lambda: len(api.frames) >= 1)
    await asyncio.sleep(0.1)
    assert [frame["payload"]["frame_seq"] for frame in api.frames] == [2]
    assert uplink.frames_superseded == 1


async def test_frames_of_different_tiles_are_all_sent(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    first, second = new_id(), new_id()
    await asyncio.gather(
        uplink.submit(payload_for(first, 1)), uplink.submit(payload_for(second, 1))
    )
    await eventually(lambda: len(api.frames) == 2)
    assert {frame["payload"]["browser_session_id"] for frame in api.frames} == {
        str(first),
        str(second),
    }


async def test_a_tile_nobody_asked_for_is_paused(uplink: FrameUplink) -> None:
    session_id = new_id()
    seen: list[TileDemand] = []
    uplink.watch_demand(session_id, seen.append)
    assert seen == [PAUSED]
    assert uplink.demand_of(session_id) == PAUSED


async def test_a_demand_message_reaches_the_listener_of_that_tile(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    session_id, other = new_id(), new_id()
    seen: list[TileDemand] = []
    ignored: list[TileDemand] = []
    uplink.watch_demand(session_id, seen.append)
    uplink.watch_demand(other, ignored.append)
    await api.send_demand(session_id, 4, 60, 640)
    await eventually(lambda: len(seen) == 2)
    assert seen[-1] == TileDemand(max_fps=4, quality=60, max_width=640)
    assert uplink.demand_of(session_id) == TileDemand(4, 60, 640)
    assert ignored == [PAUSED]


async def test_a_demand_that_arrived_before_the_listener_is_remembered(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    session_id = new_id()
    await api.send_demand(session_id, 10, 75, 1280)
    await eventually(lambda: uplink.demand_of(session_id).max_fps == 10)
    seen: list[TileDemand] = []
    uplink.watch_demand(session_id, seen.append)
    assert seen == [TileDemand(10, 75, 1280)]


async def test_an_unreadable_message_is_ignored_and_the_socket_stays_up(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    await api.send_raw("not json")
    await api.send_raw('{"type": "tile.demand"}')
    session_id = new_id()
    await api.send_demand(session_id, 4, 60, 640)
    await eventually(lambda: uplink.demand_of(session_id).max_fps == 4)
    assert uplink.connected is True


async def test_losing_the_connection_pauses_every_tile_and_forgets_the_demand(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    session_id = new_id()
    seen: list[TileDemand] = []
    uplink.watch_demand(session_id, seen.append)
    await api.send_demand(session_id, 4, 60, 640)
    await eventually(lambda: uplink.demand_of(session_id).max_fps == 4)
    await api.stop()
    await eventually(lambda: uplink.connected is False)
    assert seen[-1] == PAUSED
    assert uplink.demand_of(session_id) == PAUSED


async def test_the_uplink_reconnects_by_itself_and_hears_new_demand(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    session_id = new_id()
    await api.drop_connections()
    await eventually(lambda: uplink.connections == 2 and uplink.connected)
    await api.send_demand(session_id, 10, 75, 1280)
    await eventually(lambda: uplink.demand_of(session_id).max_fps == 10)
    await uplink.submit(payload_for(session_id, 1))
    await eventually(lambda: len(api.frames) == 1)


async def test_the_uplink_keeps_trying_until_the_api_is_there(
    worker_settings: WorkerSettings,
) -> None:
    api = FakeFrameApi(SERVICE_KEY)
    await api.start()
    port = api.port
    await api.stop()
    uplink = FrameUplink(settings_for(worker_settings, api), backoff=FAST_BACKOFF)
    await uplink.start()
    try:
        await asyncio.sleep(0.3)
        assert uplink.connected is False
        await api.start(port)
        await uplink.wait_connected(10)
        assert uplink.connected is True
    finally:
        await uplink.stop()
        await api.stop()


async def test_a_wrong_service_key_is_retried_and_never_connects_successfully(
    worker_settings: WorkerSettings, api: FakeFrameApi
) -> None:
    uplink = FrameUplink(settings_for(worker_settings, api, "x" * 40), backoff=FAST_BACKOFF)
    await uplink.start()
    try:
        await eventually(lambda: api.handshakes >= 3)
        assert api.connections == []
    finally:
        await uplink.stop()


async def test_a_frame_submitted_while_disconnected_is_dropped_at_once(
    worker_settings: WorkerSettings, api: FakeFrameApi
) -> None:
    await api.stop()
    uplink = FrameUplink(settings_for(worker_settings, api), backoff=FAST_BACKOFF)
    await uplink.start()
    try:
        await asyncio.wait_for(uplink.submit(payload_for(new_id(), 1)), 2)
        assert uplink.frames_sent == 0
    finally:
        await uplink.stop()


async def test_forgetting_a_tile_drops_its_demand_listener_and_waiting_frame(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    session_id = new_id()
    seen: list[TileDemand] = []
    uplink.watch_demand(session_id, seen.append)
    await api.send_demand(session_id, 4, 60, 640)
    await eventually(lambda: len(seen) == 2)
    uplink.forget(session_id)
    assert uplink.demand_of(session_id) == PAUSED
    await api.send_demand(session_id, 10, 75, 1280)
    await eventually(lambda: uplink.demand_of(session_id).max_fps == 10)
    assert len(seen) == 2


async def test_an_unwatched_listener_hears_nothing_more(
    uplink: FrameUplink, api: FakeFrameApi
) -> None:
    session_id = new_id()
    seen: list[TileDemand] = []
    unwatch = uplink.watch_demand(session_id, seen.append)
    unwatch()
    unwatch()
    await api.send_demand(session_id, 4, 60, 640)
    await eventually(lambda: uplink.demand_of(session_id).max_fps == 4)
    assert seen == [PAUSED]


async def test_stopping_ends_the_connection_and_releases_a_waiting_submit(
    worker_settings: WorkerSettings, api: FakeFrameApi
) -> None:
    uplink = FrameUplink(settings_for(worker_settings, api), backoff=FAST_BACKOFF)
    await uplink.start()
    await uplink.wait_connected(10)
    await uplink.stop()
    assert uplink.connected is False
    await eventually(lambda: api.connections == [])
    await asyncio.wait_for(uplink.submit(payload_for(new_id(), 1)), 2)
