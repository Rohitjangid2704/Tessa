import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update

from tessa_api.db.models import CoverageCellRow, PlanRow, ScenarioRow
from tessa_api.schemas.enums import ScenarioStatus
from tests.loop.support import (
    accepted_scenarios,
    bearer,
    count_runs,
    create_personal_token,
    run_row,
)
from tests.stage_two.support import (
    CREATE_ISSUE,
    OPEN_ISSUES,
    FakeTemporal,
    SeededTarget,
    post_run,
    seed_gracie,
)

pytestmark = pytest.mark.integration


def subset_body(seeded: SeededTarget, *scenario_ids: uuid.UUID | str) -> dict[str, Any]:
    return {"target_id": seeded.target_id, "scenario_ids": [str(item) for item in scenario_ids]}


async def plan_cells(app: FastAPI, plan_id: uuid.UUID) -> list[tuple[str, str, str]]:
    async with app.state.session_factory() as session:
        rows = await session.scalars(
            select(CoverageCellRow).where(CoverageCellRow.plan_id == plan_id)
        )
        return sorted((row.feature_id, row.role, row.interface_id) for row in rows)


async def set_scenario(app: FastAPI, scenario_id: uuid.UUID, **values: Any) -> None:
    async with app.state.session_factory() as session:
        await session.execute(
            update(ScenarioRow).where(ScenarioRow.id == scenario_id).values(**values)
        )
        await session.commit()


def problems_of(response: httpx.Response) -> list[tuple[list[Any], str]]:
    error = response.json()["error"]
    assert error["code"] == "scenarios_not_runnable"
    return [(detail["loc"], detail["code"]) for detail in error["details"]]


async def test_a_subset_run_plans_only_the_cells_of_the_listed_scenarios(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
    seeded: SeededTarget,
) -> None:
    scenarios = await accepted_scenarios(db_app, client, member_headers, seeded)
    started_before = len(temporal.started)
    response = await post_run(
        client, member_headers, subset_body(seeded, scenarios.chat), key="subset-1"
    )
    assert response.status_code == 202, response.text
    run = await run_row(db_app, response.json()["run_id"])
    assert run.config_snapshot["scenario_ids"] == [str(scenarios.chat)]
    assert run.trigger.value == "manual"
    assert str(run.target_id) == seeded.target_id
    assert run.plan_id is not None
    assert await plan_cells(db_app, run.plan_id) == [(OPEN_ISSUES, "staff", "chat_sse")]
    async with db_app.state.session_factory() as session:
        plan = await session.get(PlanRow, run.plan_id)
        assert plan is not None
        assert (plan.name, plan.saved, plan.include_api_fuzz) == ("subset", False, False)
        assert plan.selection["depth"] == "smoke"
        assert plan.selection["k"] == 1
        assert plan.selection["interface_mode"] == "api_only"
    started = temporal.started[started_before:]
    assert [(item.name, item.workflow_id) for item in started] == [
        ("ExecuteRun", f"execute-run-{run.id}")
    ]


async def test_a_subset_across_a_browser_and_an_api_interface_plans_both(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    scenarios = await accepted_scenarios(db_app, client, member_headers, seeded)
    body = subset_body(seeded, scenarios.browser, scenarios.chat, scenarios.browser)
    response = await post_run(client, member_headers, body, key="subset-2")
    assert response.status_code == 202, response.text
    run = await run_row(db_app, response.json()["run_id"])
    assert run.config_snapshot["scenario_ids"] == [str(scenarios.browser), str(scenarios.chat)]
    assert run.plan_id is not None
    assert await plan_cells(db_app, run.plan_id) == sorted(
        [(CREATE_ISSUE, "staff", "browser"), (OPEN_ISSUES, "staff", "chat_sse")]
    )
    async with db_app.state.session_factory() as session:
        plan = await session.get(PlanRow, run.plan_id)
        assert plan is not None
        assert plan.selection["interface_mode"] == "both"


async def test_every_scenario_that_cannot_run_is_reported_by_position_and_nothing_starts(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
    seeded: SeededTarget,
) -> None:
    scenarios = await accepted_scenarios(db_app, client, member_headers, seeded)
    await set_scenario(db_app, scenarios.browser, status=ScenarioStatus.in_review)
    async with db_app.state.session_factory() as session:
        admin_row = await session.get(ScenarioRow, scenarios.admin_api)
        assert admin_row is not None
        synthetic = {**admin_row.parsed, "synthetic": True}
    await set_scenario(db_app, scenarios.admin_api, parsed=synthetic)
    runs_before = await count_runs(db_app)
    started_before = len(temporal.started)
    unknown = uuid.uuid4()
    body = subset_body(seeded, scenarios.chat, unknown, scenarios.browser, scenarios.admin_api)
    response = await post_run(client, member_headers, body, key="subset-3")
    assert response.status_code == 422, response.text
    assert problems_of(response) == [
        (["body", "scenario_ids", 1], "scenario_not_found"),
        (["body", "scenario_ids", 2], "scenario_not_accepted"),
        (["body", "scenario_ids", 3], "scenario_synthetic"),
    ]
    assert await count_runs(db_app) == runs_before
    assert len(temporal.started) == started_before


async def test_a_scenario_of_another_target_is_not_found(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    scenarios = await accepted_scenarios(db_app, client, member_headers, seeded)
    other = await seed_gracie(client, member_headers, name="Other Gracie")
    response = await post_run(
        client, member_headers, subset_body(other, scenarios.chat), key="subset-4"
    )
    assert response.status_code == 422, response.text
    assert problems_of(response) == [(["body", "scenario_ids", 0], "scenario_not_found")]


@pytest.mark.parametrize(
    "body",
    [
        {"scenario_ids": [str(uuid.uuid4())]},
        {"target_id": str(uuid.uuid4())},
        {"target_id": str(uuid.uuid4()), "scenario_ids": []},
        {
            "target_id": str(uuid.uuid4()),
            "scenario_ids": [str(uuid.uuid4())],
            "plan_id": str(uuid.uuid4()),
        },
    ],
)
async def test_a_malformed_subset_request_is_a_validation_error(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    temporal: FakeTemporal,
    body: dict[str, Any],
) -> None:
    response = await post_run(client, member_headers, body, key="subset-bad")
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_failed"
    assert temporal.started == []


async def test_a_subset_run_started_with_a_personal_token_is_triggered_by_the_agent(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    scenarios = await accepted_scenarios(db_app, client, member_headers, seeded)
    token = (await create_personal_token(client, member_headers))["token"]
    response = await post_run(
        client, bearer(token), subset_body(seeded, scenarios.chat), key="subset-agent"
    )
    assert response.status_code == 202, response.text
    run = await run_row(db_app, response.json()["run_id"])
    assert run.trigger.value == "agent"
    assert run.config_snapshot["scenario_ids"] == [str(scenarios.chat)]
