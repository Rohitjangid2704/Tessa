import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import httpx
import pytest

from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.ids import new_id
from tessa_api.schemas.enums import FeedName, RunKind, UserRole
from tessa_api.schemas.events import EventEnvelope
from tessa_api.schemas.streams import IngestEvent, stream_event_adapter
from tessa_api.settings import Settings
from tessa_api.streams.feeds import FeedFilters, RunDirectory, RunIdentity, feed_stream
from tests.streams.conftest import LiveServer, StartServer
from tests.streams.run_rows import World, add_run, create_world
from tests.streams.sse_support import SseReader
from tests.streams.support import HTTP_TIMEOUT_SECONDS, OCCURRED_AT, eventually, new_hub
from tests.support import AuthHeaders, MakeUser, settings_with

pytestmark = pytest.mark.integration

FEED_PATH = "/api/v1/feeds/runs"
QueryItems = list[tuple[str, str | int | float | bool | None]]


def offline_directory(settings: Settings, capacity: int = 16) -> RunDirectory:
    return RunDirectory(create_session_factory(create_engine(settings.database_url)), capacity)


def created_payload(kind: RunKind, target_id: UUID | None, user_id: UUID) -> dict[str, Any]:
    return {
        "kind": kind.value,
        "target_id": None if target_id is None else str(target_id),
        "plan_id": None,
        "trigger": "manual",
        "created_by": str(user_id),
        "status": "queued",
    }


def run_event(
    run_id: UUID, event_type: str, key: str, payload: dict[str, Any] | None = None
) -> IngestEvent:
    return IngestEvent(
        run_id=run_id,
        type=event_type,
        payload=payload if payload is not None else {"key": key},
        dedupe_key=key,
        occurred_at=OCCURRED_AT,
    )


def status_event(run_id: UUID, key: str) -> IngestEvent:
    return run_event(
        run_id,
        "run.status_changed",
        key,
        {"status": "running", "previous": "queued", "reason": None},
    )


@asynccontextmanager
async def open_feed(
    server: LiveServer,
    headers: dict[str, str],
    params: QueryItems | None = None,
    extra_headers: dict[str, str] | None = None,
) -> AsyncIterator[tuple[httpx.Response, SseReader]]:
    async with (
        httpx.AsyncClient(base_url=server.http_url, timeout=HTTP_TIMEOUT_SECONDS) as http,
        http.stream(
            "GET", FEED_PATH, params=params, headers={**headers, **(extra_headers or {})}
        ) as response,
    ):
        yield response, SseReader(response)


async def two_targets(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> tuple[World, World, dict[str, str]]:
    member = await make_user(UserRole.member)
    headers = auth_headers(member)
    first = await create_world(server.app, client, member, headers)
    second = await create_world(server.app, client, member, headers)
    return first, second, headers


async def test_the_feed_needs_a_bearer_token(server: LiveServer) -> None:
    async with httpx.AsyncClient(base_url=server.http_url) as http:
        response = await http.get(FEED_PATH)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


async def test_an_inactive_user_is_refused(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    user = await make_user(UserRole.viewer, is_active=False)
    async with httpx.AsyncClient(base_url=server.http_url) as http:
        response = await http.get(FEED_PATH, headers=auth_headers(user))
    assert response.status_code == 401


@pytest.mark.parametrize(
    "params", [[("bogus", "1")], [("kind", "sleeping")], [("target_id", "nope")], [("run_id", "x")]]
)
async def test_unknown_or_malformed_filters_are_rejected_before_streaming(
    server: LiveServer,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    params: QueryItems,
) -> None:
    viewer = await make_user(UserRole.viewer)
    async with httpx.AsyncClient(base_url=server.http_url) as http:
        response = await http.get(FEED_PATH, params=params, headers=auth_headers(viewer))
    assert response.status_code == 422


async def test_the_feed_is_an_event_stream_that_no_proxy_may_transform_or_compress(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    async with open_feed(
        server, auth_headers(viewer), extra_headers={"Accept-Encoding": "gzip, deflate"}
    ) as (response, reader):
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["cache-control"] == "no-cache, no-transform"
        assert response.headers["x-accel-buffering"] == "no"
        assert "content-encoding" not in response.headers
        await reader.next_event()


async def test_compression_is_active_for_other_responses_on_the_same_server(
    server: LiveServer,
) -> None:
    async with httpx.AsyncClient(base_url=server.http_url) as http:
        response = await http.get("/api/v1/openapi.json", headers={"Accept-Encoding": "gzip"})
    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"


async def test_the_first_event_is_the_feed_hello(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    async with open_feed(server, auth_headers(viewer)) as (_, reader):
        frame = await reader.next_frame()
    assert frame.event == "stream.hello"
    assert frame.data is not None
    assert frame.data["run_id"] is None
    assert frame.data["seq"] is None
    assert frame.data["payload"] == {
        "run_id": None,
        "head_seq": None,
        "resumed_from": None,
        "heartbeat_seconds": 15,
        "limits": None,
        "feed": "runs",
    }
    assert stream_event_adapter.validate_python(frame.data).type == "stream.hello"


async def test_run_events_arrive_as_sse_frames_with_the_origin_seq(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    world, _, headers = await two_targets(server, client, make_user, auth_headers)
    run = await add_run(world)
    async with open_feed(server, headers) as (_, reader):
        await reader.next_event()
        await server.post_events(
            [
                run_event(
                    run.run_id,
                    "run.created",
                    "created",
                    created_payload(RunKind.suite, world.target_id, world.user_id),
                ),
                status_event(run.run_id, "status"),
                run_event(run.run_id, "hello.tick", "tick"),
            ]
        )
        created = await reader.next_event()
        status = await reader.next_event()
    assert created.event == "run.created"
    assert created.data is not None
    assert created.data["seq"] == 1
    assert created.data["run_id"] == str(run.run_id)
    assert status.event == "run.status_changed"
    assert status.data is not None
    assert status.data["seq"] == 2


async def test_events_outside_the_feed_mapping_never_arrive(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    world, _, headers = await two_targets(server, client, make_user, auth_headers)
    run = await add_run(world)
    async with open_feed(server, headers) as (_, reader):
        await reader.next_event()
        await server.post_events(
            [
                run_event(run.run_id, "hello.tick", "tick"),
                run_event(run.run_id, "step.recorded", "step"),
                status_event(run.run_id, "status"),
            ]
        )
        frame = await reader.next_event()
    assert frame.event == "run.status_changed"


async def test_the_run_id_filter_selects_one_run(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    world, _, headers = await two_targets(server, client, make_user, auth_headers)
    wanted, other = await add_run(world), await add_run(world)
    async with open_feed(server, headers, [("run_id", str(wanted.run_id))]) as (_, reader):
        await reader.next_event()
        await server.post_events(
            [status_event(other.run_id, "other"), status_event(wanted.run_id, "wanted")]
        )
        frame = await reader.next_event()
    assert frame.data is not None
    assert frame.data["run_id"] == str(wanted.run_id)


async def test_the_target_filter_uses_the_run_row_for_events_that_do_not_carry_it(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    first, second, headers = await two_targets(server, client, make_user, auth_headers)
    on_first, on_second = await add_run(first), await add_run(second)
    async with open_feed(server, headers, [("target_id", str(first.target_id))]) as (_, reader):
        await reader.next_event()
        await server.post_events(
            [status_event(on_second.run_id, "second"), status_event(on_first.run_id, "first")]
        )
        frame = await reader.next_event()
    assert frame.data is not None
    assert frame.data["run_id"] == str(on_first.run_id)


async def test_the_kind_filter_accepts_several_kinds(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    world, _, headers = await two_targets(server, client, make_user, auth_headers)
    suite = await add_run(world, RunKind.suite)
    explore = await add_run(world, RunKind.explore)
    simulate = await add_run(world, RunKind.simulate)
    params: QueryItems = [("kind", "suite"), ("kind", "simulate")]
    async with open_feed(server, headers, params) as (_, reader):
        await reader.next_event()
        await server.post_events(
            [
                status_event(explore.run_id, "explore"),
                status_event(suite.run_id, "suite"),
                status_event(simulate.run_id, "simulate"),
            ]
        )
        first = await reader.next_event()
        second = await reader.next_event()
    assert first.data is not None
    assert second.data is not None
    assert [first.data["run_id"], second.data["run_id"]] == [
        str(suite.run_id),
        str(simulate.run_id),
    ]


async def test_run_created_carries_its_own_identity_for_runs_without_a_row(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    run_id = new_id()
    async with open_feed(server, auth_headers(viewer), [("kind", "hello")]) as (_, reader):
        await reader.next_event()
        await server.post_events(
            [
                run_event(
                    run_id, "run.created", "created", created_payload(RunKind.hello, None, new_id())
                ),
                status_event(run_id, "status"),
            ]
        )
        created = await reader.next_event()
        status = await reader.next_event()
    assert (created.event, status.event) == ("run.created", "run.status_changed")


async def test_filters_combine(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    first, second, headers = await two_targets(server, client, make_user, auth_headers)
    wrong_kind = await add_run(first, RunKind.explore)
    wrong_target = await add_run(second, RunKind.suite)
    right = await add_run(first, RunKind.suite)
    params: QueryItems = [("target_id", str(first.target_id)), ("kind", "suite")]
    async with open_feed(server, headers, params) as (_, reader):
        await reader.next_event()
        await server.post_events(
            [
                status_event(wrong_kind.run_id, "kind"),
                status_event(wrong_target.run_id, "target"),
                status_event(right.run_id, "right"),
            ]
        )
        frame = await reader.next_event()
    assert frame.data is not None
    assert frame.data["run_id"] == str(right.run_id)


async def test_every_subscriber_gets_its_own_copy(
    server: LiveServer,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    world, _, headers = await two_targets(server, client, make_user, auth_headers)
    run = await add_run(world)
    async with open_feed(server, headers) as (_, first), open_feed(server, headers) as (_, second):
        await first.next_event()
        await second.next_event()
        await server.post_events([status_event(run.run_id, "status")])
        assert (await first.next_event()).event == "run.status_changed"
        assert (await second.next_event()).event == "run.status_changed"


async def test_a_ping_comment_keeps_an_idle_feed_alive(
    start_server: StartServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    server = await start_server(stream_heartbeat_seconds=1)
    viewer = await make_user(UserRole.viewer)
    async with open_feed(server, auth_headers(viewer)) as (_, reader):
        await reader.next_event()
        frame = await reader.next_frame()
    assert frame.comment == ": ping"
    assert frame.event is None


async def test_the_feed_ends_with_a_closing_event_at_the_maximum_age(
    start_server: StartServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    server = await start_server(stream_max_age_seconds=1)
    viewer = await make_user(UserRole.viewer)
    async with open_feed(server, auth_headers(viewer)) as (_, reader):
        await reader.next_event()
        closing = await reader.next_event()
        assert closing.event == "stream.closing"
        assert closing.data is not None
        assert closing.data["payload"] == {"reason": "max_age"}
        assert await reader.ended()


async def test_shutting_the_hub_down_tells_the_feed_clients(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    async with open_feed(server, auth_headers(viewer)) as (_, reader):
        await reader.next_event()
        server.hub.shutdown()
        closing = await reader.next_event()
        assert closing.data is not None
        assert closing.data["payload"] == {"reason": "shutdown"}
        assert await reader.ended()


async def test_a_client_that_goes_away_releases_its_subscription_and_holds_no_connection(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    pool: Any = server.app.state.engine.pool
    async with open_feed(server, auth_headers(viewer)) as (_, reader):
        await reader.next_event()
        assert server.hub.feed_subscriber_count(FeedName.runs) == 1
        assert pool.checkedout() == 0
    await eventually(lambda: server.hub.feed_subscriber_count(FeedName.runs) == 0)


async def test_a_feed_stream_closes_with_slow_consumer_when_its_queue_overflows() -> None:
    hub = new_hub(ws_send_queue_max=2)
    settings = settings_with(ws_send_queue_max=2)
    frames = feed_stream(hub, settings, offline_directory(settings), FeedName.runs, FeedFilters())
    assert "stream.hello" in await anext(frames)
    for seq in (1, 2, 3):
        hub.publish_persisted(
            EventEnvelope(type="run.progress", run_id=new_id(), seq=seq, ts=OCCURRED_AT, payload={})
        )
    closing = await anext(frames)
    assert "stream.closing" in closing
    assert '"slow_consumer"' in closing
    with pytest.raises(StopAsyncIteration):
        await anext(frames)
    assert hub.feed_subscriber_count(FeedName.runs) == 0


async def test_a_feed_without_filters_needs_no_database_lookup() -> None:
    hub = new_hub()
    settings = settings_with()
    frames = feed_stream(hub, settings, offline_directory(settings), FeedName.runs, FeedFilters())
    await anext(frames)
    hub.publish_persisted(
        EventEnvelope(type="run.progress", run_id=new_id(), seq=1, ts=OCCURRED_AT, payload={"a": 1})
    )
    frame = await asyncio.wait_for(anext(frames), 5)
    assert frame.startswith("event: run.progress\ndata: ")
    await frames.aclose()
    assert hub.feed_subscriber_count(FeedName.runs) == 0


def test_the_run_directory_forgets_the_oldest_runs_first() -> None:
    directory = offline_directory(settings_with(), capacity=2)
    runs = [new_id() for _ in range(3)]
    for run_id in runs:
        directory.remember(run_id, RunIdentity(RunKind.suite, None))
    assert len(directory) == 2
    assert directory.knows(runs[0]) is False
    assert directory.knows(runs[2]) is True
