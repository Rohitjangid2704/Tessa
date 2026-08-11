import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import update

from tessa_api.db.models import RunRow
from tessa_api.schemas.enums import RunStatus
from tessa_api.services.artifacts import artifact_signer_from_settings
from tessa_api.temporal_client import temporal_unavailable
from tests.stage_two.run_support import RECORDING, SHOT, TRACE, build_finished_run, start_run
from tests.stage_two.support import (
    PLANS_PATH,
    RUNS_PATH,
    FakeTemporal,
    plan_body,
    post_run,
    seed_gracie,
)

pytestmark = pytest.mark.integration

STEPS_PATH = "/api/v1/steps"
RUN_SCENARIOS_PATH = "/api/v1/run-scenarios"


def error_of(response: httpx.Response) -> dict[str, Any]:
    error: dict[str, Any] = response.json()["error"]
    return error


async def set_status(app: FastAPI, run_id: str, **values: Any) -> None:
    async with app.state.session_factory() as session:
        await session.execute(update(RunRow).where(RunRow.id == uuid.UUID(run_id)).values(**values))
        await session.commit()


async def test_the_runs_list_filters_sorts_and_pages(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    first = await seed_gracie(client, member_headers)
    second = await seed_gracie(client, member_headers, name="Second")
    handles = [
        await start_run(client, member_headers, first, key="list-key-0001"),
        await start_run(client, member_headers, first, key="list-key-0002"),
        await start_run(client, member_headers, second, key="list-key-0003"),
    ]
    ids = [handle["run_id"] for handle in handles]
    await set_status(db_app, ids[0], status=RunStatus.completed)
    await set_status(db_app, ids[1], status=RunStatus.running, started_at=datetime.now(UTC))

    async def listed(**params: Any) -> list[str]:
        response = await client.get(RUNS_PATH, params=params, headers=member_headers)
        assert response.status_code == 200, response.text
        return [item["id"] for item in response.json()["items"]]

    assert await listed() == [ids[2], ids[1], ids[0]]
    assert await listed(sort="created_at") == ids
    assert await listed(target_id=first.target_id) == [ids[1], ids[0]]
    assert await listed(status="completed") == [ids[0]]
    assert set(await listed(status=["completed", "queued"])) == {ids[0], ids[2]}
    assert await listed(kind="suite") == [ids[2], ids[1], ids[0]]
    assert await listed(kind="hello") == []
    assert await listed(status="failed") == []
    async with db_app.state.session_factory() as session:
        third = await session.get(RunRow, uuid.UUID(ids[2]))
        assert third is not None
        plan_id = third.plan_id
    assert await listed(plan_id=str(plan_id)) == [ids[2]]
    now = datetime.now(UTC)
    assert await listed(created_after=(now - timedelta(minutes=5)).isoformat()) == [
        ids[2],
        ids[1],
        ids[0],
    ]
    assert await listed(created_after=(now + timedelta(minutes=5)).isoformat()) == []
    assert await listed(created_before=(now - timedelta(minutes=5)).isoformat()) == []
    page = await client.get(
        RUNS_PATH, params={"limit": 2, "include_total": "true"}, headers=member_headers
    )
    assert page.json()["total"] == 3
    assert [item["id"] for item in page.json()["items"]] == [ids[2], ids[1]]
    rest = await client.get(
        RUNS_PATH, params={"limit": 2, "cursor": page.json()["next_cursor"]}, headers=member_headers
    )
    assert [item["id"] for item in rest.json()["items"]] == [ids[0]]
    assert rest.json()["next_cursor"] is None
    summary = page.json()["items"][1]
    assert set(summary) == {
        "id",
        "kind",
        "target_id",
        "plan_id",
        "status",
        "counters",
        "budget",
        "read_only",
        "started_at",
        "finished_at",
        "created_at",
    }
    assert summary["budget"]["elapsed_ms"] >= 0
    assert summary["status"] == "running"
    for bad in ({"bogus": "1"}, {"sort": "nope"}, {"status": "sleeping"}, {"target_id": "x"}):
        assert (await client.get(RUNS_PATH, params=bad, headers=member_headers)).status_code == 422


async def test_a_run_detail_has_the_budget_clock_and_the_temporal_link(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    handle = await start_run(client, member_headers, seeded)
    started = datetime.now(UTC) - timedelta(seconds=30)
    await set_status(
        db_app, handle["run_id"], status=RunStatus.running, started_at=started, spent_usd=1.25
    )
    detail = (await client.get(f"{RUNS_PATH}/{handle['run_id']}", headers=member_headers)).json()
    assert detail["budget"]["spent_usd"] == 1.25
    assert 29_000 <= detail["budget"]["elapsed_ms"] <= 40_000
    finished = started + timedelta(seconds=10)
    await set_status(db_app, handle["run_id"], status=RunStatus.completed, finished_at=finished)
    detail = (await client.get(f"{RUNS_PATH}/{handle['run_id']}", headers=member_headers)).json()
    assert detail["budget"]["elapsed_ms"] == 10_000
    assert detail["finished_at"] == finished.isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )
    assert (
        await client.get(f"{RUNS_PATH}/{uuid.uuid4()}", headers=member_headers)
    ).status_code == 404
    assert (await client.get(f"{RUNS_PATH}/nope", headers=member_headers)).status_code == 422


async def test_cancel_signals_the_workflow_and_answers_with_the_run(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    handle = await start_run(client, member_headers, seeded)
    path = f"{RUNS_PATH}/{handle['run_id']}/cancel"
    assert (await client.post(path, headers=viewer_headers)).status_code == 403
    assert temporal.signals == []
    response = await client.post(path, headers=member_headers)
    assert response.status_code == 202, response.text
    assert response.json()["id"] == handle["run_id"]
    assert response.json()["workflow_id"] == handle["workflow_id"]
    assert temporal.signals == [(handle["workflow_id"], "cancel")]


async def test_cancel_is_refused_for_a_finished_run_and_idempotent_while_canceling(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    handle = await start_run(client, member_headers, seeded)
    path = f"{RUNS_PATH}/{handle['run_id']}/cancel"
    await set_status(db_app, handle["run_id"], status=RunStatus.canceling)
    again = await client.post(path, headers=member_headers)
    assert again.status_code == 202
    assert again.json()["status"] == "canceling"
    assert temporal.signals == []
    for terminal in (
        RunStatus.completed,
        RunStatus.failed,
        RunStatus.canceled,
        RunStatus.budget_exceeded,
    ):
        await set_status(db_app, handle["run_id"], status=terminal)
        refused = await client.post(path, headers=member_headers)
        assert refused.status_code == 409
        assert error_of(refused)["code"] == "run_not_cancelable"
    assert temporal.signals == []
    assert (
        await client.post(f"{RUNS_PATH}/{uuid.uuid4()}/cancel", headers=member_headers)
    ).status_code == 404


async def test_cancel_maps_a_missing_workflow_and_an_unavailable_temporal(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    handle = await start_run(client, member_headers, seeded)
    path = f"{RUNS_PATH}/{handle['run_id']}/cancel"
    temporal.not_running = True
    gone = await client.post(path, headers=member_headers)
    assert gone.status_code == 409
    assert error_of(gone)["code"] == "run_not_cancelable"
    temporal.not_running = False
    temporal.signal_failure = temporal_unavailable("could not signal the workflow")
    down = await client.post(path, headers=member_headers)
    assert down.status_code == 503
    assert error_of(down)["details"][0]["code"] == "temporal"


async def test_run_scenarios_list_with_titles_verdicts_attempts_and_filters(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    finished = await build_finished_run(db_app, client, member_headers, seeded)
    path = f"{RUNS_PATH}/{finished.run_id}/scenarios"
    response = await client.get(path, headers=member_headers)
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [item["role"] for item in items] == ["staff", "manager", "staff", "admin"]
    by_role = {(item["role"], item["interface_id"]): item for item in items}
    chat = by_role[("staff", "chat_sse")]
    assert chat["id"] == str(finished.run_scenarios["chat"])
    assert chat["title"] == "Which maintenance issues are still open? (staff on chat_sse)"
    assert chat["family"] == "smart-log"
    assert chat["status"] == "finished"
    assert chat["verdict"]["status"] == "pass"
    assert (chat["attempts_total"], chat["attempts_done"]) == (2, 2)
    assert chat["duration_ms"] == 1500
    skipped = by_role[("admin", "admin_api")]
    assert skipped["status"] == "skipped"
    assert skipped["attempts_done"] == 0

    async def listed(**params: Any) -> list[str]:
        result = await client.get(path, params=params, headers=member_headers)
        assert result.status_code == 200, result.text
        return [item["role"] for item in result.json()["items"]]

    assert await listed(status="skipped") == ["admin"]
    assert await listed(verdict="fail") == ["manager"]
    assert sorted(await listed(verdict=["pass", "flaky"])) == ["staff", "staff"]
    assert sorted(await listed(family="smart-log")) == ["manager", "staff", "staff"]
    assert await listed(family="admin") == ["admin"]
    assert sorted(await listed(role=["staff", "admin"])) == ["admin", "staff", "staff"]
    assert await listed(sort="-role", limit=2) == ["staff", "staff"]
    paged = await client.get(
        path, params={"limit": 3, "include_total": "true"}, headers=member_headers
    )
    assert paged.json()["total"] == 4
    assert paged.json()["next_cursor"] is not None
    assert (
        await client.get(f"{RUNS_PATH}/{uuid.uuid4()}/scenarios", headers=member_headers)
    ).status_code == 404
    assert (
        await client.get(path, params={"verdict": "maybe"}, headers=member_headers)
    ).status_code == 422


async def test_browser_sessions_list_the_tiles_of_a_run(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    finished = await build_finished_run(db_app, client, member_headers, seeded)
    path = f"{RUNS_PATH}/{finished.run_id}/browser-sessions"
    response = await client.get(path, headers=member_headers)
    assert response.status_code == 200
    items = response.json()["items"]
    assert set(response.json()) == {"items"}
    assert [item["status"] for item in items] == ["ended", "active"] or {
        item["status"] for item in items
    } == {"ended", "active"}
    done = next(item for item in items if item["status"] == "ended")
    assert done["id"] == str(finished.sessions["done"])
    assert done["run_scenario_id"] == str(finished.run_scenarios["browser"])
    assert (
        done["scenario_title"]
        == "Create a maintenance issue from the chat panel (staff on browser)"
    )
    assert done["viewport"] == {"width": 1280, "height": 720}
    assert (done["has_recording"], done["has_trace"]) == (True, True)
    assert done["last_url"] == "http://localhost:8080/"
    assert done["ended_at"] is not None
    live = next(item for item in items if item["status"] == "active")
    assert (live["has_recording"], live["has_trace"], live["ended_at"], live["last_url"]) == (
        False,
        False,
        None,
        None,
    )
    only_active = await client.get(path, params={"status": "active"}, headers=member_headers)
    assert [item["id"] for item in only_active.json()["items"]] == [str(finished.sessions["live"])]
    assert (
        await client.get(path, params={"bogus": "1"}, headers=member_headers)
    ).status_code == 422
    assert (
        await client.get(f"{RUNS_PATH}/{uuid.uuid4()}/browser-sessions", headers=member_headers)
    ).status_code == 404


async def test_a_run_scenario_shows_attempts_step_summaries_and_the_yaml_it_ran(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    finished = await build_finished_run(db_app, client, member_headers, seeded)
    chat_id = finished.run_scenarios["chat"]
    response = await client.get(f"{RUN_SCENARIOS_PATH}/{chat_id}", headers=viewer_headers)
    assert response.status_code == 200, response.text
    detail = response.json()
    assert detail["id"] == str(chat_id)
    assert detail["status"] == "finished"
    assert [(a["attempt"], a["status"], a["verdict"]["status"]) for a in detail["attempts"]] == [
        (0, "finished", "pass"),
        (1, "finished", "fail"),
    ]
    assert [(s["attempt"], s["index"]) for s in detail["steps"]] == [(0, 0), (0, 1), (1, 0), (1, 1)]
    first = detail["steps"][0]
    assert set(first) == {
        "id",
        "index",
        "attempt",
        "adapter",
        "label",
        "ok",
        "latency_ms",
        "cost_usd",
        "tier0_failure_count",
        "screenshot_count",
        "verdict",
    }
    assert (first["adapter"], first["ok"], first["screenshot_count"]) == ("sse", True, 1)
    assert detail["steps"][2]["tier0_failure_count"] == 1
    assert detail["skip_reason"] is None
    assert detail["scenario_yaml"].startswith("schema_version: 1\n")
    assert "Which maintenance issues are still open?" in detail["scenario_yaml"]
    skipped = (
        await client.get(
            f"{RUN_SCENARIOS_PATH}/{finished.run_scenarios['users']}", headers=viewer_headers
        )
    ).json()
    assert skipped["skip_reason"] == "env_missing"
    assert skipped["steps"] == []
    assert skipped["attempts"] == []
    missing = await client.get(f"{RUN_SCENARIOS_PATH}/{uuid.uuid4()}", headers=viewer_headers)
    assert missing.status_code == 404


async def test_a_step_returns_payloads_tier0_and_signed_artifact_links_that_download(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    finished = await build_finished_run(db_app, client, member_headers, seeded)
    step_id = finished.steps["chat-1-0"]
    response = await client.get(f"{STEPS_PATH}/{step_id}", headers=member_headers)
    assert response.status_code == 200, response.text
    step = response.json()
    assert step["id"] == str(step_id)
    assert step["run_id"] == finished.run_id
    assert step["run_scenario_id"] == str(finished.run_scenarios["chat"])
    assert (step["attempt"], step["index"], step["adapter"]) == (1, 0, "sse")
    assert step["request"]["kind"] == "sse"
    assert step["request"]["headers"] == {"Authorization": "Bearer ${ADMIN_TOKEN}"}
    assert step["response"]["kind"] == "sse"
    assert step["response"]["events"][0]["data"] == "Four"
    assert step["response_truncated"] is False
    assert step["payload_purged"] is False
    assert step["ask"] == "Which maintenance issues are still open?"
    assert step["answer"] == "Four rooms have open maintenance issues."
    assert step["tools"][0]["name"] == "query_issues"
    assert step["cards"] == [{"kind": "summary", "count": 4}]
    assert step["tier0"]["passed"] is False
    assert step["tier0"]["failures"][0]["check"] == "latency"
    assert step["verdict"] is None
    assert step["cost_usd"] == 0
    assert step["gold_points"] == []
    assert step["db_checks"] == []
    assert step["probes"] == []
    assert step["judge"] is None
    assert step["evidence"] is None
    assert step["started_at"].endswith("Z")
    refs = step["artifacts"]
    assert len(refs) == 1
    reference = refs[0]
    assert reference["kind"] == "screenshot"
    assert reference["mime"] == "image/png"
    assert reference["size_bytes"] == len(SHOT)
    assert reference["url"].startswith("/api/v1/artifacts/")
    assert reference["expires_at"].endswith("Z")
    download = await client.get(reference["url"])
    assert download.status_code == 200
    assert download.content == SHOT
    assert download.headers["content-type"] == "image/png"
    assert (
        await client.get(f"{STEPS_PATH}/{uuid.uuid4()}", headers=member_headers)
    ).status_code == 404


async def test_a_browser_step_and_a_step_without_artifacts(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    finished = await build_finished_run(db_app, client, member_headers, seeded)
    browser = (
        await client.get(f"{STEPS_PATH}/{finished.steps['browser-0-0']}", headers=member_headers)
    ).json()
    assert browser["adapter"] == "browser"
    assert browser["request"]["action"] == "navigate"
    assert browser["response"]["console"] == [{"level": "error", "text": "boom"}]
    assert browser["ask"] is None
    assert browser["tools"] == []
    second = (
        await client.get(f"{STEPS_PATH}/{finished.steps['chat-0-1']}", headers=member_headers)
    ).json()
    assert second["artifacts"] == []


async def test_the_recording_and_trace_links_serve_ranges(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    finished = await build_finished_run(db_app, client, member_headers, seeded)
    signer = artifact_signer_from_settings(db_app.state.settings)
    for name, content, mime in (
        ("recording", RECORDING, "video/webm"),
        ("trace", TRACE, "application/zip"),
    ):
        token, _ = signer.sign(finished.artifacts[name])
        url = f"/api/v1/artifacts/{token}"
        ranged = await client.get(url, headers={"Range": "bytes=2-9"})
        assert ranged.status_code == 206
        assert ranged.content == content[2:10]
        assert ranged.headers["content-type"] == mime


async def test_the_read_endpoints_need_a_token(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    handle = await start_run(client, member_headers, seeded)
    run_id = handle["run_id"]
    for path in (
        RUNS_PATH,
        f"{RUNS_PATH}/{run_id}",
        f"{RUNS_PATH}/{run_id}/scenarios",
        f"{RUNS_PATH}/{run_id}/browser-sessions",
        f"{RUN_SCENARIOS_PATH}/{uuid.uuid4()}",
        f"{STEPS_PATH}/{uuid.uuid4()}",
    ):
        assert (await client.get(path)).status_code == 401, path
    assert (await client.post(f"{RUNS_PATH}/{run_id}/cancel")).status_code == 401


async def test_the_plan_and_the_run_show_the_same_cell_count_after_a_run(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan = (
        await client.post(PLANS_PATH, json=plan_body(seeded.target_id), headers=member_headers)
    ).json()
    response = await post_run(client, member_headers, {"plan_id": plan["id"]}, key="cells-key-01")
    assert response.status_code == 202
    after = (await client.get(f"{PLANS_PATH}/{plan['id']}", headers=member_headers)).json()
    assert after["cells_total"] == plan["cells_total"] == 3
