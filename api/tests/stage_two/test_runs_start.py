import uuid
from datetime import datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, update

from tessa_api.db.models import CoverageCellRow, PlanRow, RunEventRow, RunRow, Target
from tessa_api.errors import ApiError
from tessa_api.schemas.enums import RunStatus, TargetTier
from tessa_api.temporal_client import temporal_unavailable
from tests.bundle_fixtures import gracie_like_changed_zip
from tests.bundles.support import upload_zip
from tests.stage_one import create_target
from tests.stage_two.support import (
    CREATE_ISSUE,
    GRACIE_VALUES,
    OPEN_ISSUES,
    PLANS_PATH,
    RUNS_PATH,
    FakeTemporal,
    SeededTarget,
    clear_environment,
    plan_body,
    post_run,
    seed_gracie,
    set_environment,
)

pytestmark = pytest.mark.integration


def error_of(response: httpx.Response) -> dict[str, Any]:
    error: dict[str, Any] = response.json()["error"]
    return error


def inline(seeded: SeededTarget, **selection: Any) -> dict[str, Any]:
    return {"plan": plan_body(seeded.target_id, saved=False, **selection)}


async def run_rows(app: FastAPI) -> list[RunRow]:
    async with app.state.session_factory() as session:
        return list((await session.scalars(select(RunRow).order_by(RunRow.created_at))).all())


async def events_of(app: FastAPI, run_id: str) -> list[RunEventRow]:
    async with app.state.session_factory() as session:
        return list(
            (
                await session.scalars(
                    select(RunEventRow)
                    .where(RunEventRow.run_id == uuid.UUID(run_id))
                    .order_by(RunEventRow.seq)
                )
            ).all()
        )


async def test_an_inline_plan_run_is_queued_started_by_name_and_answered_with_a_handle(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    response = await post_run(client, member_headers, inline(seeded))
    assert response.status_code == 202, response.text
    handle = response.json()
    run_id = handle["run_id"]
    assert uuid.UUID(run_id).version == 7
    assert handle["workflow_id"] == f"execute-run-{run_id}"
    assert handle["kind"] == "suite"
    assert handle["status"] == "queued"
    assert handle["created_at"].endswith("Z")
    assert [(w.name, w.workflow_id) for w in temporal.started] == [
        ("ExecuteRun", f"execute-run-{run_id}")
    ]
    assert temporal.started[0].argument == {
        "run_id": run_id,
        "max_concurrency": 4,
        "reset_seed": False,
        "owns_run": True,
    }
    rows = await run_rows(db_app)
    assert len(rows) == 1
    run = rows[0]
    assert (run.kind.value, run.status, run.trigger.value, run.read_only) == (
        "suite",
        RunStatus.queued,
        "manual",
        False,
    )
    assert str(run.target_id) == seeded.target_id
    assert str(run.bundle_id) == seeded.bundle_id
    assert run.budget == {"max_usd": 5.0, "max_minutes": 30}
    assert run.counters == {
        "scenarios_total": 0,
        "scenarios_done": 0,
        "pass": 0,
        "fail": 0,
        "flaky": 0,
        "uncertain": 0,
        "skipped": 0,
        "steps_recorded": 0,
    }
    assert run.config_snapshot["bundle_id"] == seeded.bundle_id
    assert run.config_snapshot["bundle_version"] == 1
    assert len(run.config_snapshot["bundle_hash"]) == 64
    assert run.config_snapshot["scenario_versions"] == {}
    assert run.config_snapshot["seed_hash"] is None
    assert run.workflow_id == handle["workflow_id"]
    assert run.started_at is None
    assert run.finished_at is None
    async with db_app.state.session_factory() as session:
        plan = await session.get(PlanRow, run.plan_id)
        assert plan is not None
        assert plan.saved is False
        cells = await session.scalar(
            select(func.count())
            .select_from(CoverageCellRow)
            .where(CoverageCellRow.plan_id == plan.id)
        )
        assert cells == 3


async def test_run_created_is_persisted_as_the_first_event(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    handle = (await post_run(client, member_headers, inline(seeded))).json()
    events = await events_of(db_app, handle["run_id"])
    assert [(e.seq, e.type, e.dedupe_key) for e in events] == [(1, "run.created", "created")]
    run = (await run_rows(db_app))[0]
    assert events[0].payload == {
        "kind": "suite",
        "target_id": seeded.target_id,
        "plan_id": str(run.plan_id),
        "trigger": "manual",
        "created_by": str(run.created_by),
        "status": "queued",
    }
    page = await client.get(f"{RUNS_PATH}/{handle['run_id']}/events", headers=member_headers)
    assert page.status_code == 200
    assert [item["type"] for item in page.json()["items"]] == ["run.created"]


async def test_a_saved_plan_runs_by_id_and_is_repinned_to_the_latest_bundle(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan = (
        await client.post(
            PLANS_PATH, json=plan_body(seeded.target_id, name="Reads"), headers=member_headers
        )
    ).json()
    assert plan["bundle_id"] == seeded.bundle_id
    changed = await upload_zip(
        client, member_headers, gracie_like_changed_zip(seeded.token), key="changed-upload-1"
    )
    assert changed.status_code == 201
    second_bundle = changed.json()["bundle"]["id"]
    assert second_bundle != seeded.bundle_id
    response = await post_run(client, member_headers, {"plan_id": plan["id"]})
    assert response.status_code == 202, response.text
    runs = await run_rows(db_app)
    assert str(runs[0].plan_id) == plan["id"]
    assert str(runs[0].bundle_id) == second_bundle
    assert runs[0].config_snapshot["bundle_version"] == 2
    stored = (await client.get(f"{PLANS_PATH}/{plan['id']}", headers=member_headers)).json()
    assert stored["bundle_id"] == second_bundle
    assert stored["saved"] is True
    assert stored["name"] == "Reads"
    assert stored["cells_total"] == plan["cells_total"]


async def test_a_saved_plan_keeps_its_own_budget(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan = (
        await client.post(
            PLANS_PATH,
            json=plan_body(seeded.target_id, budget={"max_usd": 2.5, "max_minutes": 9}),
            headers=member_headers,
        )
    ).json()
    await post_run(client, member_headers, {"plan_id": plan["id"]})
    assert (await run_rows(db_app))[0].budget == {"max_usd": 2.5, "max_minutes": 9}


@pytest.mark.parametrize(("requested", "expected"), [(None, 4), (2, 2), (4, 4), (50, 4), (1, 1)])
async def test_the_concurrency_is_capped_by_the_server(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    temporal: FakeTemporal,
    requested: int | None,
    expected: int,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    body = inline(seeded)
    if requested is not None:
        body["max_concurrency"] = requested
    assert (await post_run(client, member_headers, body)).status_code == 202
    assert temporal.started[0].argument["max_concurrency"] == expected


async def test_the_same_key_replays_the_answer_without_a_second_run(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    body = inline(seeded)
    first = await post_run(client, member_headers, body, key="idem-key-0001")
    second = await post_run(client, member_headers, body, key="idem-key-0001")
    assert first.status_code == second.status_code == 202
    assert second.headers["Idempotency-Replayed"] == "true"
    assert second.json() == first.json()
    assert len(await run_rows(db_app)) == 1
    assert len(temporal.started) == 1
    changed = await post_run(client, member_headers, inline(seeded, k=3), key="idem-key-0001")
    assert changed.status_code == 409
    assert error_of(changed)["code"] == "idempotency_conflict"
    other_key = await post_run(client, member_headers, body, key="idem-key-0002")
    assert other_key.status_code == 202
    assert other_key.json()["run_id"] != first.json()["run_id"]
    assert len(await run_rows(db_app)) == 2


async def test_a_run_without_an_idempotency_key_or_with_both_plans_is_refused(
    client: httpx.AsyncClient, member_headers: dict[str, str], temporal: FakeTemporal
) -> None:
    seeded = await seed_gracie(client, member_headers)
    missing = await client.post(RUNS_PATH, json=inline(seeded), headers=member_headers)
    assert missing.status_code == 400
    assert error_of(missing)["code"] == "idempotency_key_required"
    both = await post_run(
        client, member_headers, {**inline(seeded), "plan_id": str(uuid.uuid4())}, key="both-0001"
    )
    assert both.status_code == 422
    neither = await post_run(client, member_headers, {}, key="neither-0001")
    assert neither.status_code == 422
    assert temporal.started == []


async def test_an_unknown_saved_plan_is_404_and_an_empty_inline_plan_is_plan_empty(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    unknown = await post_run(
        client, member_headers, {"plan_id": str(uuid.uuid4())}, key="unknown-1"
    )
    assert unknown.status_code == 404
    empty = await post_run(client, member_headers, inline(seeded, feature_ids=[]), key="empty-0001")
    assert empty.status_code == 422
    assert error_of(empty)["code"] == "plan_empty"
    assert error_of(empty)["details"][0]["loc"] == ["body", "plan", "selection"]
    assert await run_rows(db_app) == []
    assert temporal.started == []


async def test_an_inline_plan_is_validated_like_a_saved_one(
    client: httpx.AsyncClient, member_headers: dict[str, str], temporal: FakeTemporal
) -> None:
    seeded = await seed_gracie(client, member_headers)
    response = await post_run(client, member_headers, inline(seeded, k=99), key="inline-k-0001")
    assert response.status_code == 422
    assert error_of(response)["details"][0]["loc"] == ["body", "plan", "selection", "k"]
    assert temporal.started == []


async def test_a_target_without_a_valid_bundle_is_not_ready(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    target = await create_target(client, member_headers, name="Bare")
    body = {"plan": plan_body(str(target["id"]), saved=False)}
    response = await post_run(client, member_headers, body, key="bare-0001")
    assert response.status_code == 409
    assert error_of(response)["code"] == "target_not_ready"
    assert error_of(response)["details"][0]["loc"] == ["bundle"]
    assert await run_rows(db_app) == []


async def test_missing_required_variables_of_the_selected_roles_and_interfaces_are_listed(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers, values={})
    response = await post_run(
        client, member_headers, inline(seeded, roles=["staff"]), key="env-0001"
    )
    assert response.status_code == 409
    error = error_of(response)
    assert error["code"] == "target_not_ready"
    assert [detail["loc"] for detail in error["details"]] == [
        ["environment", "GRACIE_BASE_URL"],
        ["environment", "STAFF_EMAIL"],
        ["environment", "STAFF_PASSWORD"],
    ]
    assert {detail["code"] for detail in error["details"]} == {"env_missing"}
    assert "3 required environment variables have no value" in error["message"]
    assert await run_rows(db_app) == []
    assert temporal.started == []


async def test_a_variable_no_selected_cell_uses_never_blocks_the_run(
    client: httpx.AsyncClient, member_headers: dict[str, str], temporal: FakeTemporal
) -> None:
    seeded = await seed_gracie(client, member_headers)
    await clear_environment(
        client,
        member_headers,
        seeded.target_id,
        ["MANAGER_TOKEN", "ADMIN_TOKEN", "TRUTH_DB_DSN", "SMART_LOG_TENANT_ID"],
    )
    staff_only = await post_run(
        client, member_headers, inline(seeded, roles=["staff"]), key="staff-0001"
    )
    assert staff_only.status_code == 202, staff_only.text
    manager = await post_run(
        client, member_headers, inline(seeded, roles=["manager"]), key="manager-0001"
    )
    assert manager.status_code == 409
    assert [d["loc"] for d in error_of(manager)["details"]] == [["environment", "MANAGER_TOKEN"]]


async def test_a_browser_only_selection_needs_only_what_the_browser_interface_uses(
    client: httpx.AsyncClient, member_headers: dict[str, str], temporal: FakeTemporal
) -> None:
    seeded = await seed_gracie(client, member_headers)
    await clear_environment(client, member_headers, seeded.target_id, ["MANAGER_TOKEN"])
    response = await post_run(
        client,
        member_headers,
        inline(seeded, feature_ids=[CREATE_ISSUE], roles=["staff"], interface_mode="browser_only"),
        key="browser-0001",
    )
    assert response.status_code == 202, response.text


async def test_an_archived_target_cannot_be_run(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    admin_headers: dict[str, str],
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan = (
        await client.post(PLANS_PATH, json=plan_body(seeded.target_id), headers=member_headers)
    ).json()
    await client.delete(f"/api/v1/targets/{seeded.target_id}", headers=admin_headers)
    response = await post_run(client, member_headers, {"plan_id": plan["id"]}, key="arch-0001")
    assert response.status_code == 409
    assert error_of(response)["code"] == "conflict"


async def make_production(
    client: httpx.AsyncClient,
    admin_headers: dict[str, str],
    member_headers: dict[str, str],
    allow: bool,
) -> SeededTarget:
    seeded = await seed_gracie(client, member_headers)
    await set_environment(
        client, member_headers, seeded.target_id, {"GRACIE_BASE_URL": "https://shop.example.com"}
    )
    if allow:
        patched = await client.patch(
            f"/api/v1/targets/{seeded.target_id}",
            json={"allow_production": True},
            headers=admin_headers,
        )
        assert patched.status_code == 200, patched.text
    return seeded


async def target_tier(app: FastAPI, target_id: str) -> TargetTier:
    async with app.state.session_factory() as session:
        target = await session.get(Target, uuid.UUID(target_id))
        assert target is not None
        return TargetTier(target.tier)


async def test_a_url_variable_matching_the_production_patterns_forces_the_production_tier(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    admin_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await make_production(client, admin_headers, member_headers, allow=False)
    assert await target_tier(db_app, seeded.target_id) is TargetTier.qa
    response = await post_run(client, member_headers, inline(seeded), key="prod-0001")
    assert response.status_code == 409
    error = error_of(response)
    assert error["code"] == "production_blocked"
    assert error["details"][0]["loc"] == ["target", "allow_production"]
    assert await target_tier(db_app, seeded.target_id) is TargetTier.production
    assert await run_rows(db_app) == []
    assert temporal.started == []
    shown = (await client.get(f"/api/v1/targets/{seeded.target_id}", headers=member_headers)).json()
    assert shown["tier"] == "production"


async def test_an_allowed_production_target_runs_read_only(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    admin_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await make_production(client, admin_headers, member_headers, allow=True)
    response = await post_run(client, member_headers, inline(seeded), key="prod-0002")
    assert response.status_code == 202, response.text
    run = (await run_rows(db_app))[0]
    assert run.read_only is True
    detail = (await client.get(f"{RUNS_PATH}/{run.id}", headers=member_headers)).json()
    assert detail["read_only"] is True


async def test_the_preview_of_a_production_target_marks_write_features_as_blocked(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    admin_headers: dict[str, str],
) -> None:
    seeded = await make_production(client, admin_headers, member_headers, allow=True)
    preview = (
        await client.post(
            f"{PLANS_PATH}/preview",
            json=plan_body(seeded.target_id, feature_ids=[OPEN_ISSUES, CREATE_ISSUE]),
            headers=member_headers,
        )
    ).json()
    assert {
        "feature_id": CREATE_ISSUE,
        "role": None,
        "interface_id": None,
        "reason": "production_blocked",
    } in preview["skipped"]
    assert any("read-only" in warning for warning in preview["warnings"])
    assert preview["scenarios_estimated"] == 6
    blocked = await make_production(client, admin_headers, member_headers, allow=False)
    unallowed = (
        await client.post(
            f"{PLANS_PATH}/preview", json=plan_body(blocked.target_id), headers=member_headers
        )
    ).json()
    assert any("runs are blocked" in warning for warning in unallowed["warnings"])


async def test_an_explicit_production_tier_without_a_matching_url_is_guarded_too(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    admin_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    async with db_app.state.session_factory() as session:
        await session.execute(
            update(Target)
            .where(Target.id == uuid.UUID(seeded.target_id))
            .values(tier=TargetTier.production)
        )
        await session.commit()
    blocked = await post_run(client, member_headers, inline(seeded), key="explicit-1")
    assert error_of(blocked)["code"] == "production_blocked"
    await client.patch(
        f"/api/v1/targets/{seeded.target_id}",
        json={"allow_production": True},
        headers=admin_headers,
    )
    allowed = await post_run(client, member_headers, inline(seeded), key="explicit-2")
    assert allowed.status_code == 202
    assert (await run_rows(db_app))[0].read_only is True


async def test_a_qa_target_that_allows_production_still_runs_with_writes(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    admin_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    await client.patch(
        f"/api/v1/targets/{seeded.target_id}",
        json={"allow_production": True},
        headers=admin_headers,
    )
    assert (
        await post_run(client, member_headers, inline(seeded), key="qa-key-0001")
    ).status_code == 202
    assert (await run_rows(db_app))[0].read_only is False


async def test_a_workflow_start_failure_marks_the_run_failed_and_answers_503(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    temporal.start_failure = temporal_unavailable("could not start the workflow")
    response = await post_run(client, member_headers, inline(seeded), key="fail-0001")
    assert response.status_code == 503
    error = error_of(response)
    assert error["code"] == "dependency_unavailable"
    assert error["details"][0]["code"] == "temporal"
    runs = await run_rows(db_app)
    assert len(runs) == 1
    assert runs[0].status is RunStatus.failed
    assert runs[0].finished_at is not None
    events = await events_of(db_app, str(runs[0].id))
    assert [(e.seq, e.type) for e in events] == [
        (1, "run.created"),
        (2, "run.status_changed"),
        (3, "run.finished"),
    ]
    assert events[1].payload == {
        "status": "failed",
        "previous": "queued",
        "reason": "The workflow could not be started",
    }
    assert events[2].payload["status"] == "failed"
    assert events[2].payload["counters"]["scenarios_total"] == 0
    detail = await client.get(f"{RUNS_PATH}/{runs[0].id}", headers=member_headers)
    assert detail.json()["status"] == "failed"
    temporal.start_failure = None
    retry = await post_run(client, member_headers, inline(seeded), key="fail-0001")
    assert retry.status_code == 202
    assert retry.json()["run_id"] != str(runs[0].id)


async def test_an_unavailable_temporal_is_503_and_the_run_is_recorded_as_failed(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    temporal.unavailable = True
    response = await post_run(client, member_headers, inline(seeded), key="down-0001")
    assert response.status_code == 503
    assert error_of(response)["details"][0]["code"] == "temporal"
    assert [run.status for run in await run_rows(db_app)] == [RunStatus.failed]


async def test_a_duplicate_workflow_id_is_a_conflict_and_fails_the_run(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    temporal.start_failure = ApiError(409, "conflict", "Workflow was already started")
    response = await post_run(client, member_headers, inline(seeded), key="dup-0001")
    assert response.status_code == 409
    assert error_of(response)["code"] == "conflict"
    assert [run.status for run in await run_rows(db_app)] == [RunStatus.failed]


async def test_roles_and_authentication_on_the_start_endpoint(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    assert (
        await post_run(client, viewer_headers, inline(seeded), key="viewer-01")
    ).status_code == 403
    unauthenticated = await client.post(
        RUNS_PATH, json=inline(seeded), headers={"Idempotency-Key": "anon-00001"}
    )
    assert unauthenticated.status_code == 401
    assert temporal.started == []


async def test_a_run_is_visible_in_the_list_and_detail_right_after_it_starts(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers, values=GRACIE_VALUES)
    handle = (await post_run(client, member_headers, inline(seeded))).json()
    listed = await client.get(RUNS_PATH, headers=viewer_headers)
    assert [item["id"] for item in listed.json()["items"]] == [handle["run_id"]]
    detail = (await client.get(f"{RUNS_PATH}/{handle['run_id']}", headers=viewer_headers)).json()
    assert detail["status"] == "queued"
    assert detail["trigger"] == "manual"
    assert detail["workflow_id"] == handle["workflow_id"]
    assert detail["temporal_ui_url"] == (
        f"http://localhost:8233/namespaces/default/workflows/{handle['workflow_id']}"
    )
    assert detail["started_at"] is None
    assert datetime.fromisoformat(detail["created_at"]).tzinfo is not None
    assert detail["budget"] == {
        "max_usd": 5.0,
        "spent_usd": 0.0,
        "max_minutes": 30,
        "elapsed_ms": 0,
    }
    assert detail["counters"]["pass"] == 0
    assert detail["stop_requested_at"] is None
    assert detail["read_only"] is False
    assert detail["config_snapshot"]["bundle_version"] == 1
