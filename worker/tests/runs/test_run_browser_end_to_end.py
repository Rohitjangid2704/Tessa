import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from temporalio.testing import WorkflowEnvironment
from websockets.asyncio.client import connect

from tests.runs.e2e_stack import (
    POLL_SECONDS,
    WAIT_SECONDS,
    Stack,
    open_stack,
    plan_body,
    read_events,
    stack_client,
    start_run,
    wait_for_terminal,
)

pytestmark = [pytest.mark.e2e, pytest.mark.browser]

OPEN_ISSUES = "maintenance.read.open_issues"
SLOW_TARGET_SECONDS = 0.4
SLOW_TARGET_LATENCY_LIMIT_MS = 20_000


@pytest.fixture
async def stack(temporal_env: WorkflowEnvironment, database: None) -> AsyncIterator[Stack]:
    async with open_stack(
        temporal_env,
        SLOW_TARGET_SECONDS,
        with_browser=True,
        latency_limit_ms=SLOW_TARGET_LATENCY_LIMIT_MS,
    ) as opened:
        yield opened


def browser_plan(stack: Stack) -> dict[str, Any]:
    return plan_body(stack.target_id, [OPEN_ISSUES], interface_mode="browser_only")


async def collect_stream(stack: Stack, run_id: str) -> list[dict[str, Any]]:
    async with stack_client(stack) as client:
        ticket = (
            await client.post("/api/v1/ws-tickets", json={"run_id": run_id}, headers=stack.headers)
        ).json()
    received: list[dict[str, Any]] = []
    async with connect(f"{ticket['ws_url']}&last_seq=0", max_size=None) as connection:
        async with asyncio.timeout(WAIT_SECONDS):
            while True:
                event = json.loads(await connection.recv())
                received.append(event)
                if event["type"] == "run.finished":
                    return received


async def test_a_browser_run_records_a_session_with_screenshots_a_recording_a_trace_and_frames(
    stack: Stack,
) -> None:
    async with stack_client(stack) as client:
        run_id = await start_run(client, browser_plan(stack))
        streamed = asyncio.create_task(collect_stream(stack, run_id))
        run = await wait_for_terminal(client, run_id)
        received = await streamed
        assert run["status"] == "completed", run
        assert run["counters"]["scenarios_total"] == 1
        assert run["counters"]["pass"] == 1, run
        sessions = (await client.get(f"/api/v1/runs/{run_id}/browser-sessions")).json()["items"]
        [session] = sessions
        assert session["status"] == "ended"
        assert session["has_recording"] is True
        assert session["has_trace"] is True
        assert session["last_url"].endswith("/chat")
        assert session["viewport"]["width"] > 0
        [listed] = (await client.get(f"/api/v1/runs/{run_id}/scenarios")).json()["items"]
        detail = (await client.get(f"/api/v1/run-scenarios/{listed['id']}")).json()
        assert len(detail["steps"]) == 6
        assert all(step["ok"] for step in detail["steps"])
        assert sum(step["screenshot_count"] for step in detail["steps"]) >= 6
        step = (await client.get(f"/api/v1/steps/{detail['steps'][-1]['id']}")).json()
        assert step["adapter"] == "browser"
        assert step["tier0"] == {"passed": True, "failures": []}
        screenshots = [item for item in step["artifacts"] if item["kind"] == "screenshot"]
        assert screenshots
        downloaded = await client.get(screenshots[0]["url"])
        assert downloaded.status_code == 200
        assert downloaded.headers["content-type"] == "image/png"
        assert downloaded.content.startswith(b"\x89PNG")
        persisted = await read_events(client, run_id)
        types = [event["type"] for event in persisted]
        assert [event["seq"] for event in persisted] == list(range(1, len(types) + 1))
        assert types.count("browser_session.started") == 1
        assert types.count("browser_session.ended") == 1
        assert types.index("browser_session.started") < types.index("step.recorded")
        assert types.index("step.recorded") < types.index("browser_session.ended")
        assert types.count("step.recorded") == 6
        ended = persisted[types.index("browser_session.ended")]["payload"]
        assert (ended["has_recording"], ended["has_trace"]) == (True, True)
    frames = [event for event in received if event["type"] == "tile.frame"]
    assert frames, "no tile.frame reached a subscribed client"
    assert frames[0]["payload"]["browser_session_id"] == session["id"]
    assert frames[0]["payload"]["mime"] == "image/jpeg"
    assert frames[0]["seq"] is None


async def test_canceling_a_browser_run_closes_the_session_and_leaves_no_browser_behind(
    stack: Stack,
) -> None:
    async with stack_client(stack) as client:
        run_id = await start_run(client, browser_plan(stack))
        async with asyncio.timeout(WAIT_SECONDS):
            while True:
                events = await read_events(client, run_id)
                if any(event["type"] == "step.recorded" for event in events):
                    break
                await asyncio.sleep(POLL_SECONDS)
        cancel = await client.post(f"/api/v1/runs/{run_id}/cancel")
        assert cancel.status_code == 202, cancel.text
        run = await wait_for_terminal(client, run_id)
        assert run["status"] == "canceled", run
        [session] = (await client.get(f"/api/v1/runs/{run_id}/browser-sessions")).json()["items"]
        assert session["status"] == "ended"
        [listed] = (await client.get(f"/api/v1/runs/{run_id}/scenarios")).json()["items"]
        assert listed["status"] == "canceled"
        events = await read_events(client, run_id)
        assert [event["type"] for event in events].count("browser_session.ended") == 1


async def test_a_run_of_several_browser_scenarios_respects_the_context_cap(
    temporal_env: WorkflowEnvironment, database: None
) -> None:
    async with (
        open_stack(
            temporal_env,
            SLOW_TARGET_SECONDS,
            with_browser=True,
            max_contexts=1,
            latency_limit_ms=SLOW_TARGET_LATENCY_LIMIT_MS,
        ) as stack,
        stack_client(stack) as client,
    ):
        body = plan_body(
            stack.target_id,
            [OPEN_ISSUES, "maintenance.write.create_issue"],
            interface_mode="browser_only",
        )
        run_id = await start_run(client, body)
        run = await wait_for_terminal(client, run_id)
        assert run["status"] == "completed", run
        assert run["counters"]["scenarios_total"] == 2
        listed = (await client.get(f"/api/v1/runs/{run_id}/scenarios")).json()["items"]
        assert run["counters"]["pass"] == 2, [(item["title"], item["verdict"]) for item in listed]
        sessions = (await client.get(f"/api/v1/runs/{run_id}/browser-sessions")).json()["items"]
        assert len(sessions) == 2
        ordered = sorted(sessions, key=lambda item: item["started_at"])
        assert ordered[0]["ended_at"] <= ordered[1]["started_at"]
