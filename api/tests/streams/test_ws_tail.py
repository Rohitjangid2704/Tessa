import asyncio
import json
import os
import sys
import uuid
from typing import Any

import pytest

from tessa_api.schemas.enums import UserRole
from tests.streams.conftest import LiveServer
from tests.streams.support import eventually, make_batch, make_event, new_run_id
from tests.support import API_ROOT, AuthHeaders, MakeUser, suite_env_values

pytestmark = pytest.mark.integration

SCRIPT_TIMEOUT_SECONDS = 30
SCRIPT_PATIENCE = 25.0


def script_environment() -> dict[str, str]:
    return {**os.environ, **suite_env_values()}


async def run_tail(*arguments: str) -> tuple[int, list[dict[str, Any]], str]:
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "scripts/ws_tail.py",
        *arguments,
        cwd=API_ROOT,
        env=script_environment(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    async with asyncio.timeout(SCRIPT_TIMEOUT_SECONDS):
        stdout, stderr = await process.communicate()
    events = [json.loads(line) for line in stdout.decode().splitlines() if line.strip()]
    return process.returncode or 0, events, stderr.decode()


def finished_event(run_id: uuid.UUID) -> Any:
    return make_event(
        run_id,
        "finished",
        "run.finished",
        {
            "status": "completed",
            "counters": {
                "scenarios_total": 0,
                "scenarios_done": 0,
                "pass": 0,
                "fail": 0,
                "flaky": 0,
                "uncertain": 0,
                "skipped": 0,
                "steps_recorded": 0,
            },
            "spent_usd": 0.0,
            "duration_ms": 1,
        },
    )


async def bearer(make_user: MakeUser, auth_headers: AuthHeaders) -> str:
    user = await make_user(UserRole.viewer)
    return auth_headers(user)["Authorization"].removeprefix("Bearer ")


async def test_tail_prints_hello_replay_live_events_and_stops_at_run_finished(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await server.post_events(make_batch(run_id, "seed", 3))
    token = await bearer(make_user, auth_headers)

    async def finish_once_connected() -> None:
        await eventually(lambda: server.hub.run_subscriber_count(run_id) == 1, SCRIPT_PATIENCE)
        await asyncio.sleep(0.3)
        await server.post_events([make_event(run_id, "live"), finished_event(run_id)])

    finisher = asyncio.create_task(finish_once_connected())
    code, events, stderr = await run_tail(
        str(run_id), "--token", token, "--api-url", server.http_url, "--timeout", "20"
    )
    await finisher
    assert code == 0, stderr
    types = [event["type"] for event in events]
    assert types[0] == "stream.hello"
    assert types[-1] == "run.finished"
    assert types.count("stream.replay_end") == 1
    assert [event["seq"] for event in events if event["seq"] is not None] == [1, 2, 3, 4, 5]
    assert token not in stderr


async def test_tail_resumes_after_last_seq(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await server.post_events([*make_batch(run_id, "seed", 3), finished_event(run_id)])
    token = await bearer(make_user, auth_headers)
    code, events, stderr = await run_tail(
        str(run_id), "--token", token, "--api-url", server.http_url, "--last-seq", "2"
    )
    assert code == 0, stderr
    assert [event["seq"] for event in events if event["seq"] is not None] == [3, 4]
    assert events[0]["payload"]["resumed_from"] == 2


async def test_tail_gives_up_after_the_timeout_when_the_run_never_finishes(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await server.post_events(make_batch(run_id, "seed", 2))
    token = await bearer(make_user, auth_headers)
    code, events, stderr = await run_tail(
        str(run_id), "--token", token, "--api-url", server.http_url, "--timeout", "1.5"
    )
    assert code == 0
    assert "stopped after 1.5 seconds" in stderr
    assert [event["type"] for event in events] == [
        "stream.hello",
        "hello.tick",
        "hello.tick",
        "stream.replay_end",
    ]


async def test_tail_keeps_going_after_run_finished_with_follow(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await server.post_events([make_event(run_id, "a"), finished_event(run_id)])
    token = await bearer(make_user, auth_headers)
    code, events, stderr = await run_tail(
        str(run_id),
        "--token",
        token,
        "--api-url",
        server.http_url,
        "--follow",
        "--timeout",
        "1.5",
    )
    assert code == 0
    assert events[-1]["type"] == "stream.replay_end"
    assert "run.finished" in {event["type"] for event in events}
    assert "stopped after" in stderr


async def test_tail_reports_a_rejected_ticket_request(server: LiveServer) -> None:
    run_id = new_run_id()
    await server.post_events(make_batch(run_id, "seed", 1))
    code, events, stderr = await run_tail(
        str(run_id), "--token", "not-a-token", "--api-url", server.http_url
    )
    assert code == 1
    assert events == []
    assert "ticket request failed: 401" in stderr


async def test_tail_reports_an_unknown_run(
    server: LiveServer, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    token = await bearer(make_user, auth_headers)
    code, events, stderr = await run_tail(
        str(new_run_id()), "--token", token, "--api-url", server.http_url
    )
    assert code == 1
    assert events == []
    assert "ticket request failed: 404" in stderr
