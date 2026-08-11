import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update

from tessa_api.db.models import CoverageCellRow, RunRow
from tessa_api.schemas.enums import CellStatus, RunStatus, SkipReason, VerdictStatus
from tessa_api.services.plans import (
    expand_plan_cells,
    plan_cells_with_skips,
    record_cell_verdicts,
    worst_verdict,
)
from tests.stage_two.run_support import build_finished_run, start_run
from tests.stage_two.support import (
    CREATE_ISSUE,
    OPEN_ISSUES,
    PLANS_PATH,
    RUNS_PATH,
    FakeTemporal,
    clear_environment,
    plan_body,
    post_run,
    seed_gracie,
)

pytestmark = pytest.mark.integration


async def set_run_status(app: FastAPI, run_id: str, status: RunStatus) -> None:
    async with app.state.session_factory() as session:
        await session.execute(
            update(RunRow).where(RunRow.id == uuid.UUID(run_id)).values(status=status)
        )
        await session.commit()


async def test_a_plan_with_a_run_in_progress_cannot_be_changed_or_deleted(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan = (
        await client.post(PLANS_PATH, json=plan_body(seeded.target_id), headers=member_headers)
    ).json()
    handle = (await post_run(client, member_headers, {"plan_id": plan["id"]})).json()
    path = f"{PLANS_PATH}/{plan['id']}"
    other = plan_body(seeded.target_id, feature_ids=[CREATE_ISSUE])["selection"]
    for active in (RunStatus.queued, RunStatus.planning, RunStatus.running, RunStatus.canceling):
        await set_run_status(db_app, handle["run_id"], active)
        patched = await client.patch(path, json={"selection": other}, headers=member_headers)
        assert patched.status_code == 409, active
        assert patched.json()["error"]["code"] == "conflict"
        assert (await client.delete(path, headers=member_headers)).status_code == 409
    renamed = await client.patch(path, json={"name": "Still allowed"}, headers=member_headers)
    assert renamed.status_code == 200
    await set_run_status(db_app, handle["run_id"], RunStatus.completed)
    assert (
        await client.patch(path, json={"selection": other}, headers=member_headers)
    ).status_code == 200
    assert (await client.delete(path, headers=member_headers)).status_code == 204


async def test_deleting_a_plan_keeps_its_runs_readable_without_a_plan(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan = (
        await client.post(PLANS_PATH, json=plan_body(seeded.target_id), headers=member_headers)
    ).json()
    handle = (await post_run(client, member_headers, {"plan_id": plan["id"]})).json()
    await set_run_status(db_app, handle["run_id"], RunStatus.completed)
    assert (
        await client.delete(f"{PLANS_PATH}/{plan['id']}", headers=member_headers)
    ).status_code == 204
    run = (await client.get(f"{RUNS_PATH}/{handle['run_id']}", headers=member_headers)).json()
    assert run["plan_id"] is None
    assert run["status"] == "completed"
    async with db_app.state.session_factory() as session:
        remaining = (
            await session.scalars(
                select(CoverageCellRow).where(CoverageCellRow.plan_id == uuid.UUID(plan["id"]))
            )
        ).all()
        assert remaining == []


async def test_the_cells_of_an_unknown_plan_are_404(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await client.get(f"{PLANS_PATH}/{uuid.uuid4()}/cells", headers=member_headers)
    assert response.status_code == 404
    assert (
        await client.patch(f"{PLANS_PATH}/{uuid.uuid4()}", json={}, headers=member_headers)
    ).status_code == 404


async def test_the_worker_facing_expansion_is_idempotent_and_classifies_skips(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan = (
        await client.post(
            PLANS_PATH,
            json=plan_body(seeded.target_id, feature_ids=[OPEN_ISSUES, CREATE_ISSUE]),
            headers=member_headers,
        )
    ).json()
    plan_id = uuid.UUID(plan["id"])
    async with db_app.state.session_factory() as session:
        first = await expand_plan_cells(session, plan_id)
        second = await expand_plan_cells(session, plan_id)
        await session.commit()
    assert first == second
    assert len(first) == len(set(first)) == 5
    async with db_app.state.session_factory() as session:
        writable = await plan_cells_with_skips(session, plan_id, read_only=False)
        read_only = await plan_cells_with_skips(session, plan_id, read_only=True)
    assert {cell.skip_reason for cell in writable.cells} == {None}
    assert {
        cell.feature_id
        for cell in read_only.cells
        if cell.skip_reason is SkipReason.production_blocked
    } == {CREATE_ISSUE}
    await clear_environment(client, member_headers, seeded.target_id, ["MANAGER_TOKEN"])
    async with db_app.state.session_factory() as session:
        after = await plan_cells_with_skips(session, plan_id, read_only=False)
    assert {
        (cell.feature_id, cell.role): cell.skip_reason
        for cell in after.cells
        if cell.skip_reason is not None
    } == {
        (OPEN_ISSUES, "manager"): SkipReason.role_unavailable,
        (CREATE_ISSUE, "manager"): SkipReason.role_unavailable,
    }


def test_the_worst_verdict_follows_the_precedence() -> None:
    assert worst_verdict([VerdictStatus.pass_, VerdictStatus.fail]) is VerdictStatus.fail
    assert worst_verdict([VerdictStatus.pass_, VerdictStatus.flaky]) is VerdictStatus.flaky
    assert worst_verdict([VerdictStatus.pass_, VerdictStatus.uncertain]) is VerdictStatus.uncertain
    assert worst_verdict([VerdictStatus.skipped, VerdictStatus.pass_]) is VerdictStatus.pass_
    assert worst_verdict([VerdictStatus.skipped]) is VerdictStatus.skipped


async def test_run_verdicts_land_on_the_cells_of_the_plan(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    finished = await build_finished_run(db_app, client, member_headers, seeded)
    async with db_app.state.session_factory() as session:
        updated = await record_cell_verdicts(session, uuid.UUID(finished.run_id))
        await session.commit()
    assert updated == 4
    cells = (
        await client.get(f"{PLANS_PATH}/{finished.plan_id}/cells", headers=member_headers)
    ).json()["items"]
    by_key: dict[tuple[str, str, str], dict[str, Any]] = {
        (cell["feature_id"], cell["role"], cell["interface_id"]): cell for cell in cells
    }
    assert by_key[(OPEN_ISSUES, "staff", "chat_sse")]["last_verdict"] == "pass"
    assert by_key[(OPEN_ISSUES, "manager", "chat_sse")]["last_verdict"] == "fail"
    assert by_key[(CREATE_ISSUE, "staff", "browser")]["last_verdict"] == "flaky"
    assert by_key[("admin.users.list", "admin", "admin_api")]["last_verdict"] == "skipped"
    assert by_key[(OPEN_ISSUES, "staff", "chat_sse")]["status"] == CellStatus.covered.value
    assert by_key[("admin.users.list", "admin", "admin_api")]["status"] == CellStatus.covered.value
    assert by_key[(OPEN_ISSUES, "admin", "chat_sse")]["last_verdict"] is None
    async with db_app.state.session_factory() as session:
        again = await record_cell_verdicts(session, uuid.UUID(finished.run_id))
        assert again == 4
        assert await record_cell_verdicts(session, uuid.uuid4()) == 0


async def test_a_started_run_leaves_cells_untouched_until_verdicts_arrive(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    handle = await start_run(client, member_headers, seeded)
    async with db_app.state.session_factory() as session:
        assert await record_cell_verdicts(session, uuid.UUID(handle["run_id"])) == 0
