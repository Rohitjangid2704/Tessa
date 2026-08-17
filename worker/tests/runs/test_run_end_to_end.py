import asyncio
import uuid
from collections import Counter
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from temporalio.testing import WorkflowEnvironment

from tests.fake_target.app import TOKEN_DELAY_SECONDS
from tests.fake_target.dataset import MANAGER_TOKEN
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

pytestmark = pytest.mark.e2e

DIRTY_ROOMS = "rooms.read.dirty"
ROOMS_LIST = "rooms.read.list"
INVARIANT_FAMILY = "invariant"
SEED_UNVERIFIED = (
    "seed_unverified: the seed has no expected hash yet; reset it once so the first hash is "
    "recorded"
)
ATTACK_INVARIANTS = ("refuses_out_of_scope", "injection_resistance", "authority_pressure")
BOUNDARY_INVARIANTS = ("auth_boundaries", "role_monotonicity")


@pytest.fixture
def target_delay() -> float:
    return TOKEN_DELAY_SECONDS


@pytest.fixture
async def stack(
    temporal_env: WorkflowEnvironment, database: None, target_delay: float
) -> AsyncIterator[Stack]:
    async with open_stack(temporal_env, target_delay) as opened:
        yield opened


async def run_scenarios(client: httpx.AsyncClient, run_id: str) -> list[dict[str, Any]]:
    response = await client.get(f"/api/v1/runs/{run_id}/scenarios", params={"limit": 200})
    items: list[dict[str, Any]] = response.json()["items"]
    return items


def planned_of(listed: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [item for item in listed if item["family"] != INVARIANT_FAMILY]


def synthetic_of(listed: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [item for item in listed if item["family"] == INVARIANT_FAMILY]


def verdict_counts(listed: list[dict[str, Any]]) -> Counter[str]:
    return Counter(item["verdict"]["status"] for item in listed)


def titled(listed: list[dict[str, Any]], invariant_id: str) -> list[dict[str, Any]]:
    return [item for item in listed if item["title"].startswith(f"Invariant {invariant_id}:")]


async def set_environment(client: httpx.AsyncClient, stack: Stack, values: dict[str, str]) -> None:
    response = await client.patch(
        f"/api/v1/targets/{stack.target_id}/environment", json={"set": values}
    )
    assert response.status_code == 200, response.text


async def move_finding(client: httpx.AsyncClient, finding_id: str, status: str) -> None:
    response = await client.patch(f"/api/v1/findings/{finding_id}", json={"status": status})
    assert response.status_code == 200, response.text


async def test_a_run_of_http_and_sse_scenarios_completes_against_the_fake_target(
    stack: Stack,
) -> None:
    async with stack_client(stack) as client:
        run_id = await start_run(client, plan_body(stack.target_id, [DIRTY_ROOMS, ROOMS_LIST]))
        run = await wait_for_terminal(client, run_id)
        assert run["status"] == "completed", run
        listed = await run_scenarios(client, run_id)
        planned = planned_of(listed)
        synthetic = synthetic_of(listed)
        assert len(planned) == 6
        assert {(item["role"], item["interface_id"]) for item in planned} == {
            (role, interface)
            for role in ("staff", "manager", "admin")
            for interface in ("chat_sse", "api")
        }
        assert {item["status"] for item in listed} == {"finished"}
        api = [item for item in planned if item["interface_id"] == "api"]
        chat = [item for item in planned if item["interface_id"] == "chat_sse"]
        assert {item["verdict"]["status"] for item in api} == {"pass"}
        assert {item["verdict"]["status"] for item in chat} == {"uncertain"}
        assert {item["verdict"]["reason_code"] for item in chat} == {"judge_unavailable"}
        for invariant_id in BOUNDARY_INVARIANTS:
            assert set(verdict_counts(titled(synthetic, invariant_id))) == {"pass"}
        for invariant_id in ATTACK_INVARIANTS:
            assert set(verdict_counts(titled(synthetic, invariant_id))) == {"uncertain"}
        counters = run["counters"]
        totals = verdict_counts(listed)
        assert counters["scenarios_total"] == len(listed)
        assert counters["scenarios_done"] == len(listed)
        assert counters["pass"] == totals["pass"]
        assert counters["uncertain"] == totals["uncertain"]
        assert counters["fail"] == 0
        assert run["started_at"] is not None
        assert run["finished_at"] is not None
        detail = (await client.get(f"/api/v1/run-scenarios/{api[0]['id']}")).json()
        assert detail["attempts"] == [
            {"attempt": 0, "status": "finished", "verdict": detail["attempts"][0]["verdict"]}
        ]
        [summary] = detail["steps"]
        step = (await client.get(f"/api/v1/steps/{summary['id']}")).json()
        assert step["tier0"] == {"passed": True, "failures": []}
        assert step["response"]["status"] == 200
        events = await read_events(client, run_id)
        seqs = [event["seq"] for event in events]
        assert seqs == list(range(1, len(seqs) + 1))
        types = [event["type"] for event in events]
        assert types[0] == "run.created"
        assert types[-1] == "run.finished"
        assert types.count("scenario.queued") == len(listed)
        assert types.count("scenario.started") == len(listed)
        assert types.count("scenario.finished") == len(listed)
        assert types.count("step.recorded") == counters["steps_recorded"]
        assert types.count("step.graded") == counters["steps_recorded"]
        changes = [
            (event["payload"]["previous"], event["payload"]["status"], event["payload"]["reason"])
            for event in events
            if event["type"] == "run.status_changed"
        ]
        assert changes == [
            ("queued", "planning", None),
            ("planning", "seeding", None),
            ("seeding", "running", SEED_UNVERIFIED),
            ("running", "completed", None),
        ]
        assert run["event_head_seq"] == seqs[-1]
        cells = (await client.get(f"/api/v1/plans/{run['plan_id']}/cells")).json()["items"]
        assert len(cells) == 6
        assert Counter(cell["last_verdict"] for cell in cells) == Counter(
            {"pass": 3, "uncertain": 3}
        )
        assert {cell["status"] for cell in cells} == {"covered"}
        assert len(run["config_snapshot"]["scenario_versions"]) == len(listed)
        assert run["config_snapshot"]["scenario_ids"] is None


async def test_every_scenario_is_run_k_times_and_a_wrong_answer_fails_the_scenario(
    stack: Stack,
) -> None:
    async with stack_client(stack) as client:
        await set_environment(client, stack, {"MANAGER_TOKEN": "revoked"})
        run_id = await start_run(client, plan_body(stack.target_id, [ROOMS_LIST], k=2))
        run = await wait_for_terminal(client, run_id)
        assert run["status"] == "completed", run
        listed = await run_scenarios(client, run_id)
        by_role = {item["role"]: item for item in planned_of(listed)}
        assert set(by_role) == {"staff", "manager", "admin"}
        assert by_role["staff"]["verdict"]["status"] == "pass"
        assert by_role["admin"]["verdict"]["status"] == "pass"
        assert by_role["manager"]["verdict"]["status"] == "fail"
        assert {item["attempts_done"] for item in by_role.values()} == {2}
        assert run["counters"]["fail"] == verdict_counts(listed)["fail"]
        assert run["counters"]["pass"] == verdict_counts(listed)["pass"]


async def test_a_failure_becomes_a_finding_and_a_subset_rerun_after_the_fix_resolves_it(
    stack: Stack,
) -> None:
    async with stack_client(stack) as client:
        await set_environment(client, stack, {"MANAGER_TOKEN": "revoked"})
        run_id = await start_run(client, plan_body(stack.target_id, [ROOMS_LIST]))
        assert (await wait_for_terminal(client, run_id))["status"] == "completed"
        manager = next(
            item
            for item in planned_of(await run_scenarios(client, run_id))
            if item["role"] == "manager"
        )
        assert manager["verdict"]["status"] == "fail"
        found = (
            await client.get(
                "/api/v1/findings",
                params={"target_id": stack.target_id, "scenario_id": manager["scenario_id"]},
            )
        ).json()["items"]
        assert len(found) == 1
        finding_id = found[0]["id"]
        assert found[0]["status"] == "new"
        repro = await client.get(f"/api/v1/findings/{finding_id}/repro")
        assert repro.status_code == 200, repro.text

        await set_environment(client, stack, {"MANAGER_TOKEN": MANAGER_TOKEN})
        await move_finding(client, finding_id, "in_fix")
        await move_finding(client, finding_id, "verifying")
        response = await client.post(
            "/api/v1/runs",
            json={"target_id": stack.target_id, "scenario_ids": [manager["scenario_id"]]},
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )
        assert response.status_code == 202, response.text
        rerun_id = str(response.json()["run_id"])
        rerun = await wait_for_terminal(client, rerun_id)
        assert rerun["status"] == "completed", rerun
        assert rerun["config_snapshot"]["scenario_ids"] == [manager["scenario_id"]]
        [rerun_scenario] = await run_scenarios(client, rerun_id)
        assert rerun_scenario["scenario_id"] == manager["scenario_id"]
        assert rerun_scenario["verdict"]["status"] == "pass"
        resolved = (await client.get(f"/api/v1/findings/{finding_id}")).json()
        assert resolved["status"] == "resolved"


@pytest.mark.parametrize("target_delay", [0.6])
async def test_canceling_a_run_mid_flight_ends_it_canceled_with_nothing_left_running(
    stack: Stack,
) -> None:
    async with stack_client(stack) as client:
        run_id = await start_run(client, plan_body(stack.target_id, [DIRTY_ROOMS]))
        async with asyncio.timeout(WAIT_SECONDS):
            while True:
                events = await read_events(client, run_id)
                if any(event["type"] == "scenario.started" for event in events):
                    break
                await asyncio.sleep(POLL_SECONDS)
        cancel = await client.post(f"/api/v1/runs/{run_id}/cancel")
        assert cancel.status_code == 202, cancel.text
        run = await wait_for_terminal(client, run_id)
        assert run["status"] == "canceled", run
        listed = await run_scenarios(client, run_id)
        assert len(planned_of(listed)) == 3
        statuses = {item["status"] for item in listed}
        assert statuses <= {"canceled", "skipped", "finished"}
        assert "canceled" in statuses
        assert run["counters"]["scenarios_done"] == len(listed)
        events = await read_events(client, run_id)
        changes = [
            event["payload"]["status"] for event in events if event["type"] == "run.status_changed"
        ]
        assert changes[-2:] == ["canceling", "canceled"]
        assert [event["type"] for event in events].count("scenario.finished") == len(listed)
