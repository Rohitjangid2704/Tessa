import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pytest
from jsonschema import Draft202012Validator
from sqlalchemy import delete, update
from websockets.exceptions import ConnectionClosed

from tessa_api.db.models import RunEventRow, User
from tessa_api.ids import new_id
from tessa_api.schemas.enums import UserRole
from tessa_api.schemas.streams import stream_event_adapter
from tessa_api.services.schema_registry import SCHEMAS, build_schema_document
from tests.streams.conftest import LiveServer, StartServer
from tests.streams.support import (
    closed_with,
    eventually,
    make_batch,
    make_event,
    new_run_id,
    receive_event,
    receive_seqs,
    receive_until,
)
from tests.support import MakeUser

pytestmark = pytest.mark.integration

CONTROL_TYPES = {
    "stream.hello",
    "stream.replay_end",
    "stream.resync_required",
    "stream.heartbeat",
    "stream.closing",
    "stream.error",
}


async def seeded_run(server: LiveServer, count: int = 3) -> uuid.UUID:
    run_id = new_run_id()
    response = await server.post_events(make_batch(run_id, "seed", count))
    assert response.status_code == 200
    return run_id


async def new_viewer(make_user: MakeUser) -> User:
    return await make_user(UserRole.viewer)


async def test_stream_starts_with_hello_then_replays_then_signals_the_end(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 3)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=0) as stream:
        events = await receive_until(stream, "stream.replay_end")
    assert [event["type"] for event in events] == [
        "stream.hello",
        "hello.tick",
        "hello.tick",
        "hello.tick",
        "stream.replay_end",
    ]
    assert [event["seq"] for event in events] == [None, 1, 2, 3, None]
    assert events[-1]["payload"] == {"through_seq": 3}


async def test_hello_carries_head_seq_heartbeat_and_tile_limits(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 3)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=2) as stream:
        hello = await receive_event(stream)
    settings = server.settings
    assert hello["type"] == "stream.hello"
    assert hello["run_id"] == str(run_id)
    assert hello["seq"] is None
    assert hello["ts"].endswith("Z")
    assert hello["payload"] == {
        "run_id": str(run_id),
        "head_seq": 3,
        "resumed_from": 2,
        "heartbeat_seconds": settings.stream_heartbeat_seconds,
        "limits": {
            "max_tiles": settings.live_max_tiles_per_client,
            "grid": {
                "max_fps": settings.live_grid_max_fps,
                "quality": settings.live_grid_quality,
                "max_width": settings.live_grid_max_width,
            },
            "focus": {
                "max_fps": settings.live_focus_max_fps,
                "quality": settings.live_focus_quality,
                "max_width": settings.live_focus_max_width,
            },
        },
        "feed": None,
    }


async def test_without_last_seq_the_log_is_replayed_from_the_start(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 2)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id) as stream:
        events = await receive_until(stream, "stream.replay_end")
    assert events[0]["payload"]["resumed_from"] is None
    assert [event["seq"] for event in events if event["seq"] is not None] == [1, 2]


async def test_resume_replays_only_events_after_last_seq(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 5)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=3) as stream:
        events = await receive_until(stream, "stream.replay_end")
    assert [event["seq"] for event in events if event["seq"] is not None] == [4, 5]
    assert events[0]["payload"]["resumed_from"] == 3


async def test_resume_at_the_head_replays_nothing(server: LiveServer, make_user: MakeUser) -> None:
    run_id = await seeded_run(server, 3)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=3) as stream:
        events = await receive_until(stream, "stream.replay_end")
    assert [event["type"] for event in events] == ["stream.hello", "stream.replay_end"]
    assert events[-1]["payload"] == {"through_seq": 3}


async def test_live_events_follow_the_replay_in_order(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 2)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=0) as stream:
        await receive_until(stream, "stream.replay_end")
        await server.post_events(make_batch(run_id, "live", 3))
        live = [await receive_event(stream) for _ in range(3)]
    assert [event["seq"] for event in live] == [3, 4, 5]
    assert {event["run_id"] for event in live} == {str(run_id)}


async def test_deduplicated_retries_are_not_sent_twice(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 1)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=1) as stream:
        await receive_until(stream, "stream.replay_end")
        batch = make_batch(run_id, "live", 2)
        await server.post_events(batch)
        await server.post_events(batch)
        await server.post_events([make_event(run_id, "after")])
        seqs = [(await receive_event(stream))["seq"] for _ in range(3)]
    assert seqs == [2, 3, 4]


async def test_events_of_other_runs_and_ephemeral_events_are_not_delivered(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 1)
    other = await seeded_run(server, 1)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=1) as stream:
        await receive_until(stream, "stream.replay_end")
        await server.post_events([make_event(other, "noise")])
        await server.post_events([make_event(run_id, None, "dashboard.invalidate", ephemeral=True)])
        await server.post_events([make_event(run_id, "mine")])
        event = await receive_event(stream)
    assert event["seq"] == 2
    assert event["run_id"] == str(run_id)


async def test_control_events_validate_against_the_published_stream_event_schema(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(stream_heartbeat_seconds=1, stream_max_age_seconds=2)
    run_id = await seeded_run(server, 1)
    user = await new_viewer(make_user)
    definition = next(item for item in SCHEMAS if item.name == "stream-event")
    validator = Draft202012Validator(build_schema_document(definition))
    async with await server.open_stream(user, run_id, last_seq=0) as stream:
        controls = [
            event
            for event in await receive_until(stream, "stream.closing")
            if event["type"] in CONTROL_TYPES
        ]
    assert {"stream.hello", "stream.replay_end", "stream.heartbeat", "stream.closing"} <= {
        event["type"] for event in controls
    }
    for event in controls:
        validator.validate(event)
        stream_event_adapter.validate_python(event)


async def test_replay_joins_live_events_without_gap_or_duplicate(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 2)
    user = await new_viewer(make_user)
    batches = 30
    final_seq = 2 + batches * 4

    async def produce() -> None:
        for batch in range(batches):
            await server.post_events(make_batch(run_id, f"p{batch}", 4))
            await asyncio.sleep(0.003)

    producer = asyncio.create_task(produce())
    streams = []
    for delay in (0.0, 0.03, 0.06, 0.1):
        await asyncio.sleep(delay)
        streams.append(await server.open_stream(user, run_id, last_seq=0))
    try:
        results = await asyncio.gather(*(receive_seqs(stream, final_seq) for stream in streams))
    finally:
        for stream in streams:
            await stream.close()
    await producer
    for seqs in results:
        assert seqs == list(range(1, final_seq + 1))


async def test_a_large_batch_landing_during_connect_is_delivered_exactly_once(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 1)
    user = await new_viewer(make_user)
    burst = asyncio.create_task(server.post_events(make_batch(run_id, "burst", 300)))
    async with await server.open_stream(user, run_id, last_seq=0) as stream:
        seqs = await receive_seqs(stream, 301)
    await burst
    assert seqs == list(range(1, 302))


async def test_replay_larger_than_one_database_batch_arrives_complete_and_in_order(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = new_run_id()
    for chunk in range(3):
        await server.post_events(make_batch(run_id, f"chunk{chunk}", 400))
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=0) as stream:
        events = await receive_until(stream, "stream.replay_end")
    assert [event["seq"] for event in events if event["seq"] is not None] == list(range(1, 1201))
    assert events[-1]["payload"] == {"through_seq": 1200}


async def test_resume_after_a_drop_continues_from_the_last_seq(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 2)
    user = await new_viewer(make_user)
    first = await server.open_stream(user, run_id, last_seq=0)
    seen = await receive_seqs(first, 2)
    await first.close()
    await server.post_events(make_batch(run_id, "while-away", 3))
    async with await server.open_stream(user, run_id, last_seq=seen[-1]) as second:
        resumed = await receive_seqs(second, 5)
    assert seen == [1, 2]
    assert resumed == [3, 4, 5]


async def test_gap_larger_than_the_replay_limit_asks_for_a_resync(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(stream_replay_max_events=5)
    run_id = await seeded_run(server, 12)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=0) as stream:
        events = [await receive_event(stream) for _ in range(2)]
        code, reason = await closed_with(stream)
    assert [event["type"] for event in events] == ["stream.hello", "stream.resync_required"]
    assert events[1]["payload"] == {"reason": "gap_too_large", "min_seq": 8}
    assert (code, reason) == (1000, "resync_required")


async def test_gap_exactly_at_the_replay_limit_is_still_replayed(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(stream_replay_max_events=5)
    run_id = await seeded_run(server, 12)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=7) as stream:
        events = await receive_until(stream, "stream.replay_end")
    assert [event["seq"] for event in events if event["seq"] is not None] == [8, 9, 10, 11, 12]


async def test_trimmed_log_asks_for_a_resync_with_reason_retention(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 8)
    async with server.app.state.session_factory() as session:
        await session.execute(delete(RunEventRow).where(RunEventRow.seq <= 3))
        await session.commit()
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=1) as stream:
        events = [await receive_event(stream) for _ in range(2)]
    assert events[1]["type"] == "stream.resync_required"
    assert events[1]["payload"] == {"reason": "retention", "min_seq": 4}
    async with await server.open_stream(user, run_id, last_seq=3) as stream:
        resumed = await receive_until(stream, "stream.replay_end")
    assert [event["seq"] for event in resumed if event["seq"] is not None] == [4, 5, 6, 7, 8]


async def test_last_seq_ahead_of_the_log_asks_for_a_resync(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server, 3)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=50) as stream:
        events = [await receive_event(stream) for _ in range(2)]
    assert events[1]["payload"] == {"reason": "retention", "min_seq": 1}


async def test_origin_outside_the_cors_list_is_closed_with_4403(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, origin="http://evil.example") as stream:
        assert await closed_with(stream) == (4403, "origin_not_allowed")


@pytest.mark.parametrize(
    "origin", [None, "http://localhost:3000", "http://127.0.0.1:3000", "http://LOCALHOST:3000/"]
)
async def test_allowed_or_absent_origin_is_accepted(
    server: LiveServer, make_user: MakeUser, origin: str | None
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, origin=origin) as stream:
        assert (await receive_event(stream))["type"] == "stream.hello"


async def test_rejection_is_only_visible_after_the_handshake_completes(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    stream = await server.open_stream(user, run_id, ticket="")
    assert await closed_with(stream) == (4401, "ticket_required")


async def test_garbage_and_forged_tickets_are_closed_with_4401(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    now = int(datetime.now(UTC).timestamp())
    forged = jwt.encode(
        {
            "typ": "ws-ticket",
            "sub": str(user.id),
            "run_id": str(run_id),
            "jti": str(new_id()),
            "iat": now,
            "exp": now + 30,
        },
        "another-secret-another-secret-0123456789",
        algorithm="HS256",
    )
    for ticket in ("garbage", forged):
        async with await server.open_stream(user, run_id, ticket=ticket) as stream:
            assert await closed_with(stream) == (4401, "ticket_invalid")


async def test_api_token_is_not_accepted_as_a_ticket(
    server: LiveServer, make_user: MakeUser, auth_headers: Any
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    api_token = auth_headers(user)["Authorization"].removeprefix("Bearer ")
    async with await server.open_stream(user, run_id, ticket=api_token) as stream:
        assert (await closed_with(stream))[0] == 4401


async def test_expired_ticket_is_closed_with_4401(server: LiveServer, make_user: MakeUser) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    ticket = server.ticket_for(user, run_id, datetime.now(UTC) - timedelta(minutes=5))
    async with await server.open_stream(user, run_id, ticket=ticket) as stream:
        assert await closed_with(stream) == (4401, "ticket_expired")


async def test_ticket_works_once_and_a_replay_is_closed_with_4401(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    ticket = server.ticket_for(user, run_id)
    async with await server.open_stream(user, run_id, ticket=ticket) as first:
        assert (await receive_event(first))["type"] == "stream.hello"
    async with await server.open_stream(user, run_id, ticket=ticket) as second:
        assert await closed_with(second) == (4401, "ticket_already_used")


async def test_ticket_for_another_run_is_closed_with_4403(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    other = await seeded_run(server)
    user = await new_viewer(make_user)
    ticket = server.ticket_for(user, run_id)
    async with await server.open_stream(user, other, ticket=ticket) as stream:
        assert await closed_with(stream) == (4403, "ticket_run_mismatch")


async def test_unknown_run_is_closed_with_4404(server: LiveServer, make_user: MakeUser) -> None:
    user = await new_viewer(make_user)
    async with await server.open_stream(user, new_run_id()) as stream:
        assert await closed_with(stream) == (4404, "unknown_run")


async def test_malformed_run_id_in_the_path_is_closed_with_4404(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, path_run_id="not-a-uuid") as stream:
        assert await closed_with(stream) == (4404, "unknown_run")


@pytest.mark.parametrize("last_seq", ["abc", "-1", "1.5", ""])
async def test_invalid_last_seq_is_closed_with_4400(
    server: LiveServer, make_user: MakeUser, last_seq: str
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=last_seq) as stream:
        assert await closed_with(stream) == (4400, "invalid_last_seq")


async def test_inactive_user_is_closed_with_4401(server: LiveServer, make_user: MakeUser) -> None:
    run_id = await seeded_run(server)
    user = await make_user(UserRole.viewer, is_active=False)
    async with await server.open_stream(user, run_id) as stream:
        assert await closed_with(stream) == (4401, "unknown_or_inactive_user")


async def test_user_deactivated_after_minting_is_closed_with_4401(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    ticket = server.ticket_for(user, run_id)
    async with server.app.state.session_factory() as session:
        await session.execute(update(User).where(User.id == user.id).values(is_active=False))
        await session.commit()
    async with await server.open_stream(user, run_id, ticket=ticket) as stream:
        assert (await closed_with(stream))[0] == 4401


@pytest.mark.parametrize("role", [UserRole.viewer, UserRole.member, UserRole.admin])
async def test_every_role_may_watch_a_run(
    server: LiveServer, make_user: MakeUser, role: UserRole
) -> None:
    run_id = await seeded_run(server)
    user = await make_user(role)
    async with await server.open_stream(user, run_id) as stream:
        assert (await receive_event(stream))["type"] == "stream.hello"


async def test_connection_cap_per_user_closes_the_extra_stream_with_4429(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(ws_max_connections_per_user=2)
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    other = await new_viewer(make_user)
    first = await server.open_stream(user, run_id)
    second = await server.open_stream(user, run_id)
    for stream in (first, second):
        assert (await receive_event(stream))["type"] == "stream.hello"
    async with await server.open_stream(user, run_id) as third:
        assert await closed_with(third) == (4429, "too_many_connections")
    async with await server.open_stream(other, run_id) as unaffected:
        assert (await receive_event(unaffected))["type"] == "stream.hello"
    await first.close()
    await eventually(lambda: server.hub.connection_count(user.id) == 1)
    async with await server.open_stream(user, run_id) as replacement:
        assert (await receive_event(replacement))["type"] == "stream.hello"
    await second.close()


async def test_slots_are_released_when_clients_disconnect(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    stream = await server.open_stream(user, run_id)
    await receive_event(stream)
    assert server.hub.connection_count(user.id) == 1
    assert server.hub.run_subscriber_count(run_id) == 1
    await stream.close()
    await eventually(lambda: server.hub.connection_count(user.id) == 0)
    assert server.hub.run_subscriber_count(run_id) == 0


async def test_invalid_client_message_gets_stream_error_then_4400(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=3) as stream:
        await receive_until(stream, "stream.replay_end")
        await stream.send("this is not json")
        error = await receive_event(stream)
        assert error["type"] == "stream.error"
        assert error["payload"]["code"] == "bad_request"
        assert await closed_with(stream) == (4400, "bad_client_message")


@pytest.mark.parametrize(
    "message",
    [
        {"type": "nope", "payload": {}},
        {"type": "tile.ack", "payload": {"frame_seq": 1}},
        {"type": "tile.subscribe", "payload": {"tiles": [{"mode": "grid"}]}},
        [1, 2, 3],
    ],
)
async def test_messages_outside_the_client_schema_close_with_4400(
    server: LiveServer, make_user: MakeUser, message: Any
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=3) as stream:
        await receive_until(stream, "stream.replay_end")
        await stream.send(json.dumps(message))
        assert (await receive_event(stream))["type"] == "stream.error"
        assert (await closed_with(stream))[0] == 4400


async def test_binary_client_message_that_is_not_json_closes_with_4400(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=3) as stream:
        await receive_until(stream, "stream.replay_end")
        await stream.send(b"\x00\x01\x02")
        assert (await receive_event(stream))["type"] == "stream.error"
        assert (await closed_with(stream))[0] == 4400


async def test_valid_tile_messages_are_accepted_and_the_stream_continues(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    session_id = str(new_id())
    async with await server.open_stream(user, run_id, last_seq=3) as stream:
        await receive_until(stream, "stream.replay_end")
        await stream.send(
            json.dumps(
                {
                    "type": "tile.subscribe",
                    "payload": {"tiles": [{"browser_session_id": session_id, "mode": "grid"}]},
                }
            )
        )
        await stream.send(
            json.dumps(
                {"type": "tile.ack", "payload": {"browser_session_id": session_id, "frame_seq": 4}}
            )
        )
        await server.post_events([make_event(run_id, "still-alive")])
        assert (await receive_event(stream))["seq"] == 4


async def test_stream_ends_at_max_age_with_closing_and_4408(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(stream_max_age_seconds=1)
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=3) as stream:
        events = await receive_until(stream, "stream.closing")
        assert events[-1]["payload"] == {"reason": "max_age"}
        assert await closed_with(stream) == (4408, "max_age")


async def test_heartbeats_arrive_at_the_configured_interval(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(stream_heartbeat_seconds=1)
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    loop = asyncio.get_running_loop()
    async with await server.open_stream(user, run_id, last_seq=3) as stream:
        await receive_until(stream, "stream.replay_end")
        started = loop.time()
        await receive_until(stream, "stream.heartbeat")
        first = loop.time() - started
        await receive_until(stream, "stream.heartbeat")
        second = loop.time() - started
    assert 0.5 <= first <= 4.0
    assert 1.5 <= second <= 6.0


async def test_heartbeats_continue_while_events_flow(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(stream_heartbeat_seconds=1)
    run_id = await seeded_run(server, 1)
    user = await new_viewer(make_user)

    async def produce() -> None:
        for batch in range(40):
            await server.post_events([make_event(run_id, f"flow:{batch}")])
            await asyncio.sleep(0.1)

    producer = asyncio.create_task(produce())
    async with await server.open_stream(user, run_id, last_seq=1) as stream:
        await receive_until(stream, "stream.replay_end")
        events = await receive_until(stream, "stream.heartbeat")
    producer.cancel()
    await asyncio.gather(producer, return_exceptions=True)
    assert any(event["seq"] is not None for event in events[:-1])


async def test_slow_consumer_gets_closing_and_4413_instead_of_losing_events(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(ws_send_queue_max=2)
    run_id = await seeded_run(server, 1)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=1) as stream:
        await receive_until(stream, "stream.replay_end")
        await server.post_events(make_batch(run_id, "burst", 10))
        events = await receive_until(stream, "stream.closing")
        assert events[-1]["payload"] == {"reason": "slow_consumer"}
        assert await closed_with(stream) == (4413, "slow_consumer")
    await eventually(lambda: server.hub.connection_count(user.id) == 0)
    async with await server.open_stream(user, run_id, last_seq=1) as resumed:
        replayed = await receive_until(resumed, "stream.replay_end")
    assert [event["seq"] for event in replayed if event["seq"] is not None] == list(range(2, 12))


async def test_a_queue_that_fits_the_burst_does_not_overflow(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(ws_send_queue_max=10)
    run_id = await seeded_run(server, 1)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=1) as stream:
        await receive_until(stream, "stream.replay_end")
        await server.post_events(make_batch(run_id, "burst", 10))
        seqs = await receive_seqs(stream, 11)
    assert seqs == list(range(2, 12))


async def test_server_shutdown_notice_closes_the_stream_with_1001(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    async with await server.open_stream(user, run_id, last_seq=3) as stream:
        await receive_until(stream, "stream.replay_end")
        server.hub.shutdown()
        events = await receive_until(stream, "stream.closing")
        assert events[-1]["payload"] == {"reason": "shutdown"}
        assert await closed_with(stream) == (1001, "shutdown")


async def test_database_outage_during_the_handshake_closes_with_1013(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(
        database_url="postgresql+asyncpg://tessa:dev-only-unused@127.0.0.1:1/tessa"
    )
    user = await new_viewer(make_user)
    run_id = new_run_id()
    async with await server.open_stream(user, run_id) as stream:
        assert await closed_with(stream) == (1013, "database_unavailable")


async def test_closing_the_client_side_ends_the_session_quietly(
    server: LiveServer, make_user: MakeUser
) -> None:
    run_id = await seeded_run(server)
    user = await new_viewer(make_user)
    stream = await server.open_stream(user, run_id)
    await receive_event(stream)
    await stream.close(code=1000)
    with pytest.raises(ConnectionClosed):
        await stream.recv()
    await eventually(lambda: server.hub.run_subscriber_count(run_id) == 0)
