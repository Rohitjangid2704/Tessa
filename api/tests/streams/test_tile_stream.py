import asyncio
import json
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from uuid import UUID

import httpx
import pytest
from sqlalchemy import select
from websockets.asyncio.client import ClientConnection

from tessa_api.db.models import RunRow, User
from tessa_api.ids import new_id
from tessa_api.schemas.enums import BrowserSessionStatus, UserRole
from tessa_api.schemas.streams import IngestEvent
from tests.streams.conftest import LiveServer, StartServer
from tests.streams.run_rows import RunRows, World, add_run, create_world, started_payload
from tests.streams.support import (
    OCCURRED_AT,
    closed_with,
    eventually,
    make_batch,
    make_event,
    receive_event,
    receive_until,
)
from tests.streams.tile_support import (
    ack_text,
    frame_text,
    open_worker_socket,
    receive_demand,
    receive_demand_until,
    receive_tile_frame,
    subscribe_text,
    tile_frames_within,
)
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration

GRID_FPS = 4
FOCUS_FPS = 10


def session_started(run: RunRows, session_id: UUID) -> IngestEvent:
    return IngestEvent(
        run_id=run.run_id,
        type="browser_session.started",
        payload=started_payload(session_id, run.run_scenario_id),
        dedupe_key=f"started:{session_id}",
        occurred_at=OCCURRED_AT,
    )


async def open_run_stream(server: LiveServer, user: User, run_id: UUID) -> ClientConnection:
    stream = await server.open_stream(user, run_id, last_seq=0)
    await receive_until(stream, "stream.replay_end")
    return stream


@dataclass
class Scene:
    server: LiveServer
    member: User
    world: World
    run: RunRows
    headers: dict[str, str]

    @property
    def run_id(self) -> UUID:
        return self.run.run_id

    @property
    def session_id(self) -> UUID:
        return self.run.session_ids[0]

    @property
    def service_key(self) -> str:
        return self.server.settings.service_key.get_secret_value()

    async def announce_session(self) -> None:
        response = await self.server.post_events([session_started(self.run, self.session_id)])
        assert response.status_code == 200

    async def open_stream(self) -> ClientConnection:
        return await open_run_stream(self.server, self.member, self.run_id)

    @asynccontextmanager
    async def watching(self) -> AsyncIterator[tuple[ClientConnection, ClientConnection]]:
        async with (
            await open_worker_socket(self.server.port, self.service_key) as worker,
            await open_run_stream(self.server, self.member, self.run_id) as stream,
        ):
            yield worker, stream


async def build_scene(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    sessions: int = 1,
    session_status: BrowserSessionStatus = BrowserSessionStatus.active,
) -> Scene:
    member = await make_user(UserRole.member)
    headers = auth_headers(member)
    world = await create_world(server.app, client, member, headers)
    run = await add_run(world, sessions=sessions, session_status=session_status)
    return Scene(server, member, world, run, headers)


@pytest.fixture
async def scene(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> Scene:
    built = await build_scene(server, client, make_user, auth_headers)
    await built.announce_session()
    return built


def focus_demand_registered(server: LiveServer, session_id: UUID) -> bool:
    demand = server.hub.tiles.demand_of(session_id)
    return demand is not None and demand.max_fps == FOCUS_FPS


async def test_a_run_with_a_row_and_no_events_gets_a_ticket_and_a_stream(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    quiet = await build_scene(server, client, make_user, auth_headers, sessions=0)
    async with httpx.AsyncClient(base_url=server.http_url) as http:
        response = await http.post(
            "/api/v1/ws-tickets", json={"run_id": str(quiet.run_id)}, headers=quiet.headers
        )
    assert response.status_code == 200
    stream = await server.open_stream(quiet.member, quiet.run_id, ticket=response.json()["ticket"])
    async with stream:
        events = await receive_until(stream, "stream.replay_end")
    assert events[0]["type"] == "stream.hello"
    assert events[0]["payload"]["head_seq"] == 0
    assert events[-1]["payload"] == {"through_seq": 0}


async def test_a_run_without_row_and_events_is_still_unknown(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    member = await make_user(UserRole.member)
    async with httpx.AsyncClient(base_url=server.http_url) as http:
        response = await http.post(
            "/api/v1/ws-tickets", json={"run_id": str(new_id())}, headers=auth_headers(member)
        )
    assert response.status_code == 404
    stream = await server.open_stream(member, new_id())
    async with stream:
        assert await closed_with(stream) == (4404, "unknown_run")


async def test_a_hello_run_without_a_row_keeps_working(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    member = await make_user(UserRole.member)
    run_id = new_id()
    await server.post_events(make_batch(run_id, "hello", 2))
    async with httpx.AsyncClient(base_url=server.http_url) as http:
        response = await http.post(
            "/api/v1/ws-tickets", json={"run_id": str(run_id)}, headers=auth_headers(member)
        )
    assert response.status_code == 200
    async with await server.open_stream(member, run_id, last_seq=0) as stream:
        events = await receive_until(stream, "stream.replay_end")
    assert [event["seq"] for event in events if event["seq"] is not None] == [1, 2]


async def test_ingest_moves_the_event_head_seq_of_the_run_row_in_the_same_transaction(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    quiet = await build_scene(server, client, make_user, auth_headers, sessions=0)

    async def head() -> int:
        async with server.app.state.session_factory() as session:
            row = await session.scalar(select(RunRow).where(RunRow.id == quiet.run_id))
            assert row is not None
            return int(row.event_head_seq)

    assert await head() == 0
    await server.post_events(make_batch(quiet.run_id, "first", 3))
    assert await head() == 3
    await server.post_events(make_batch(quiet.run_id, "first", 3))
    assert await head() == 3
    await server.post_events([make_event(quiet.run_id, "ephemeral", ephemeral=True)])
    assert await head() == 3
    await server.post_events(make_batch(quiet.run_id, "second", 2))
    assert await head() == 5


async def test_frames_flow_from_the_worker_to_a_subscribed_client(scene: Scene) -> None:
    async with scene.watching() as (worker, stream):
        await stream.send(subscribe_text((scene.session_id, "grid")))
        demand = await receive_demand_until(worker, scene.session_id, GRID_FPS)
        assert demand["payload"] == {
            "browser_session_id": str(scene.session_id),
            "max_fps": GRID_FPS,
            "quality": 60,
            "max_width": 640,
        }
        await worker.send(frame_text(scene.session_id, 1))
        event = await receive_tile_frame(stream)
    assert event["run_id"] == str(scene.run_id)
    assert event["seq"] is None
    assert event["payload"]["browser_session_id"] == str(scene.session_id)
    assert event["payload"]["frame_seq"] == 1
    assert event["payload"]["mime"] == "image/jpeg"


async def test_tile_frames_are_ephemeral_and_leave_the_event_log_alone(scene: Scene) -> None:
    async with scene.watching() as (worker, stream):
        await stream.send(subscribe_text((scene.session_id, "grid")))
        await receive_demand_until(worker, scene.session_id, GRID_FPS)
        await worker.send(frame_text(scene.session_id, 1))
        await receive_tile_frame(stream)
    async with await scene.server.open_stream(scene.member, scene.run_id, last_seq=0) as replay:
        events = await receive_until(replay, "stream.replay_end")
    assert [event["type"] for event in events] == [
        "stream.hello",
        "browser_session.started",
        "stream.replay_end",
    ]


async def test_a_tile_nobody_subscribed_to_receives_no_frames(scene: Scene) -> None:
    async with scene.watching() as (worker, stream):
        await stream.send(subscribe_text())
        await receive_demand_until(worker, scene.session_id, 0)
        for frame_seq in range(1, 4):
            await worker.send(frame_text(scene.session_id, frame_seq))
        assert await tile_frames_within(stream, 0.6) == []


async def test_before_the_first_message_every_active_tile_is_wanted_as_grid(scene: Scene) -> None:
    async with scene.watching() as (worker, stream):
        demand = await receive_demand_until(worker, scene.session_id, GRID_FPS)
        assert demand["payload"]["max_width"] == 640
        await worker.send(frame_text(scene.session_id, 1))
        event = await receive_tile_frame(stream)
    assert event["payload"]["frame_seq"] == 1


async def test_frames_are_latest_wins_and_at_most_two_stay_unacked(scene: Scene) -> None:
    async with scene.watching() as (worker, stream):
        await stream.send(subscribe_text((scene.session_id, "grid")))
        await receive_demand_until(worker, scene.session_id, GRID_FPS)
        await worker.send(frame_text(scene.session_id, 1))
        assert (await receive_tile_frame(stream))["payload"]["frame_seq"] == 1
        for frame_seq in range(2, 6):
            await worker.send(frame_text(scene.session_id, frame_seq))
        assert (await receive_tile_frame(stream))["payload"]["frame_seq"] == 5
        await worker.send(frame_text(scene.session_id, 6))
        await worker.send(frame_text(scene.session_id, 7))
        assert await tile_frames_within(stream, 0.8) == []
        await stream.send(ack_text(scene.session_id, 5))
        assert (await receive_tile_frame(stream))["payload"]["frame_seq"] == 7


async def test_an_ack_of_the_first_frame_only_frees_one_place(scene: Scene) -> None:
    async with scene.watching() as (worker, stream):
        await stream.send(subscribe_text((scene.session_id, "grid")))
        await receive_demand_until(worker, scene.session_id, GRID_FPS)
        await worker.send(frame_text(scene.session_id, 1))
        await receive_tile_frame(stream)
        await worker.send(frame_text(scene.session_id, 2))
        assert (await receive_tile_frame(stream))["payload"]["frame_seq"] == 2
        await worker.send(frame_text(scene.session_id, 3))
        assert await tile_frames_within(stream, 0.6) == []
        await stream.send(ack_text(scene.session_id, 1))
        assert (await receive_tile_frame(stream))["payload"]["frame_seq"] == 3
        await worker.send(frame_text(scene.session_id, 4))
        assert await tile_frames_within(stream, 0.6) == []


async def test_frames_are_paced_to_the_grid_frame_rate(scene: Scene) -> None:
    async with scene.watching() as (worker, stream):
        await stream.send(subscribe_text((scene.session_id, "grid")))
        await receive_demand_until(worker, scene.session_id, GRID_FPS)
        await worker.send(frame_text(scene.session_id, 1))
        await receive_tile_frame(stream)
        started = time.monotonic()
        await stream.send(ack_text(scene.session_id, 1))
        await worker.send(frame_text(scene.session_id, 2))
        await receive_tile_frame(stream)
        assert time.monotonic() - started >= 0.2


async def test_demand_is_the_maximum_across_clients_and_zero_when_nobody_watches(
    scene: Scene,
) -> None:
    async with await open_worker_socket(scene.server.port, scene.service_key) as worker:
        first = await scene.open_stream()
        second = await scene.open_stream()
        await first.send(subscribe_text((scene.session_id, "grid")))
        await second.send(subscribe_text((scene.session_id, "focus")))
        focus = await receive_demand_until(worker, scene.session_id, FOCUS_FPS)
        assert focus["payload"]["quality"] == 75
        assert focus["payload"]["max_width"] == 1280
        await second.close()
        grid = await receive_demand_until(worker, scene.session_id, GRID_FPS)
        assert grid["payload"]["max_width"] == 640
        await first.send(subscribe_text())
        stopped = await receive_demand_until(worker, scene.session_id, 0)
        assert stopped["payload"]["browser_session_id"] == str(scene.session_id)
        await first.close()


async def test_closing_the_last_client_stops_the_demand(scene: Scene) -> None:
    async with await open_worker_socket(scene.server.port, scene.service_key) as worker:
        stream = await scene.open_stream()
        await stream.send(subscribe_text((scene.session_id, "grid")))
        await receive_demand_until(worker, scene.session_id, GRID_FPS)
        await stream.close()
        await receive_demand_until(worker, scene.session_id, 0)


async def test_a_worker_socket_that_connects_later_learns_the_current_demand(scene: Scene) -> None:
    async with await scene.open_stream() as stream:
        await stream.send(subscribe_text((scene.session_id, "focus")))
        await eventually(lambda: focus_demand_registered(scene.server, scene.session_id))
        async with await open_worker_socket(scene.server.port, scene.service_key) as worker:
            demand = await receive_demand(worker)
    assert demand["payload"]["max_fps"] == FOCUS_FPS


async def test_a_client_reconnecting_after_a_restart_finds_the_active_sessions_in_the_database(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    restarted = await build_scene(server, client, make_user, auth_headers, sessions=2)
    assert server.hub.tiles.active_sessions(restarted.run_id) == []
    second_session = restarted.run.session_ids[1]
    async with restarted.watching() as (worker, stream):
        await stream.send(subscribe_text((second_session, "grid")))
        demand = await receive_demand_until(worker, second_session, GRID_FPS)
        assert server.hub.tiles.active_sessions(restarted.run_id) == restarted.run.session_ids
    assert demand["payload"]["max_fps"] == GRID_FPS


async def test_ended_sessions_are_not_registered_from_the_database(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    finished = await build_scene(
        server, client, make_user, auth_headers, session_status=BrowserSessionStatus.ended
    )
    async with await finished.open_stream():
        assert server.hub.tiles.active_sessions(finished.run_id) == []


async def test_a_frame_of_a_session_the_hub_has_not_seen_is_resolved_from_the_database(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    unseen = await build_scene(server, client, make_user, auth_headers)
    async with await open_worker_socket(server.port, unseen.service_key) as worker:
        await worker.send(frame_text(unseen.session_id, 4))
        await eventually(lambda: server.hub.tiles.is_registered(unseen.session_id))
        async with await unseen.open_stream() as stream:
            await stream.send(subscribe_text((unseen.session_id, "grid")))
            event = await receive_tile_frame(stream)
    assert event["payload"]["frame_seq"] == 4


async def test_frames_of_unknown_or_ended_sessions_are_dropped_quietly(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    finished = await build_scene(
        server, client, make_user, auth_headers, session_status=BrowserSessionStatus.ended
    )
    stranger = new_id()
    async with await open_worker_socket(server.port, finished.service_key) as worker:
        await worker.send(frame_text(finished.session_id, 1))
        await worker.send(frame_text(stranger, 1))
        await eventually(lambda: server.hub.tiles.recently_unknown(stranger))
        await worker.ping()
        assert worker.close_code is None
    assert not server.hub.tiles.is_registered(finished.session_id)


async def test_ending_the_session_stops_its_frames(scene: Scene) -> None:
    assert scene.server.hub.tiles.is_registered(scene.session_id)
    await scene.server.post_events(
        [
            IngestEvent(
                run_id=scene.run_id,
                type="browser_session.ended",
                payload={"browser_session_id": str(scene.session_id)},
                dedupe_key=f"ended:{scene.session_id}",
                occurred_at=OCCURRED_AT,
            )
        ]
    )
    assert not scene.server.hub.tiles.is_registered(scene.session_id)


async def test_more_tiles_than_the_limit_close_the_stream_with_a_bad_message(
    start_server: StartServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    small = await start_server(live_max_tiles_per_client=2)
    limited = await build_scene(small, client, make_user, auth_headers, sessions=3)
    async with await limited.open_stream() as stream:
        await stream.send(
            subscribe_text(*((session, "grid") for session in limited.run.session_ids))
        )
        events = await receive_until(stream, "stream.error")
        assert events[-1]["payload"]["code"] == "bad_request"
        assert "at most 2" in events[-1]["payload"]["message"]
        assert await closed_with(stream) == (4400, "bad_client_message")


async def test_exactly_the_limit_of_tiles_is_accepted(
    start_server: StartServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    small = await start_server(live_max_tiles_per_client=2)
    limited = await build_scene(small, client, make_user, auth_headers, sessions=2)
    async with await limited.open_stream() as stream:
        await stream.send(
            subscribe_text(*((session, "grid") for session in limited.run.session_ids))
        )
        await stream.send(ack_text(limited.run.session_ids[0], 3))
        await asyncio.sleep(0.2)
        assert stream.close_code is None


async def test_the_hello_limits_show_the_clamped_tile_policy(
    start_server: StartServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    clamped = await build_scene(
        await start_server(live_grid_max_fps=60, live_grid_quality=5, live_focus_max_width=4000),
        client,
        make_user,
        auth_headers,
        sessions=0,
    )
    async with await clamped.server.open_stream(
        clamped.member, clamped.run_id, last_seq=0
    ) as stream:
        hello = await receive_event(stream)
    limits = hello["payload"]["limits"]
    assert limits["grid"] == {"max_fps": 15, "quality": 30, "max_width": 640}
    assert limits["focus"] == {"max_fps": 10, "quality": 75, "max_width": 1920}


async def test_a_malformed_ack_still_closes_with_a_bad_message(scene: Scene) -> None:
    async with await scene.open_stream() as stream:
        await stream.send(json.dumps({"type": "tile.ack", "payload": {"frame_seq": 1}}))
        assert await closed_with(stream) == (4400, "bad_client_message")


async def test_shutting_the_hub_down_closes_the_worker_socket_with_going_away(
    server: LiveServer,
) -> None:
    key = server.settings.service_key.get_secret_value()
    async with await open_worker_socket(server.port, key) as worker:
        await worker.ping()
        server.hub.shutdown()
        assert await closed_with(worker) == (1001, "shutdown")


async def test_every_worker_socket_gets_the_demand_and_any_of_them_may_send_frames(
    scene: Scene,
) -> None:
    async with (
        await open_worker_socket(scene.server.port, scene.service_key) as first,
        await open_worker_socket(scene.server.port, scene.service_key) as second,
        await scene.open_stream() as stream,
    ):
        await stream.send(subscribe_text((scene.session_id, "grid")))
        await receive_demand_until(first, scene.session_id, GRID_FPS)
        await receive_demand_until(second, scene.session_id, GRID_FPS)
        await second.send(frame_text(scene.session_id, 1))
        assert (await receive_tile_frame(stream))["payload"]["frame_seq"] == 1
