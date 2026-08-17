import uuid

import httpx
import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from tessa_api.db.models import CoverageCellRow, RunRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.enums import RunScenarioStatus, SkipReason, VerdictStatus
from tessa_api.schemas.temporal import (
    CreateRunScenariosInput,
    ExpandCellsInput,
    GenerateSmokeScenarioInput,
    ValidateScenarioInput,
)
from tessa_api.services.storage import LocalBundleStore
from tessa_api.settings import Settings
from tessa_worker.activities.scenarios import ScenarioPlanningActivities
from tessa_worker.event_client import EventClient
from tests.adapters.support import RegisteredTarget
from tests.runs.support import (
    RecordingIngest,
    create_plan_through_api,
    insert_run_for_plan,
    load_run,
    load_run_scenarios,
)

pytestmark = pytest.mark.integration

OPEN_ISSUES = "maintenance.read.open_issues"
DIRTY_ROOMS = "rooms.read.dirty"
CREATE_ISSUE = "maintenance.write.create_issue"
ROOMS_LIST = "rooms.read.list"


@pytest.fixture
def activities(
    session_factory: SessionFactory, event_client: EventClient, api_settings: Settings
) -> ScenarioPlanningActivities:
    return ScenarioPlanningActivities(
        session_factory, LocalBundleStore(api_settings.data_dir), event_client
    )


async def prepare_plan(
    asgi_client: httpx.AsyncClient,
    registered: RegisteredTarget,
    activities: ScenarioPlanningActivities,
    feature_ids: list[str],
    roles: list[str] | None = None,
    interface_mode: str = "api_only",
    k: int = 1,
) -> uuid.UUID:
    plan_id = await create_plan_through_api(
        asgi_client, registered.headers, registered.target_id, feature_ids, roles, interface_mode, k
    )
    environment = ActivityEnvironment()
    expanded = await environment.run(activities.expand_cells, ExpandCellsInput(plan_id=plan_id))
    for cell_id in expanded.cell_ids:
        generated = await environment.run(
            activities.generate_smoke_scenario, GenerateSmokeScenarioInput(cell_id=cell_id)
        )
        for scenario_id in generated.scenario_ids:
            await environment.run(
                activities.validate_scenario, ValidateScenarioInput(scenario_id=scenario_id)
            )
    return plan_id


async def clear_variables(
    asgi_client: httpx.AsyncClient, registered: RegisteredTarget, names: list[str]
) -> None:
    response = await asgi_client.patch(
        f"/api/v1/targets/{registered.target_id}/environment",
        json={"clear": names},
        headers=registered.headers,
    )
    assert response.status_code == 200, response.text


async def create_run(
    session_factory: SessionFactory,
    registered: RegisteredTarget,
    plan_id: uuid.UUID,
    **options: bool,
) -> uuid.UUID:
    return await insert_run_for_plan(
        session_factory,
        registered.target_id,
        registered.bundle_id,
        plan_id,
        registered.user_id,
        **options,
    )


async def test_expanding_a_plan_materialises_one_cell_per_feature_role_and_interface(
    activities: ScenarioPlanningActivities,
    session_factory: SessionFactory,
    asgi_client: httpx.AsyncClient,
    registered: RegisteredTarget,
) -> None:
    plan_id = await create_plan_through_api(
        asgi_client, registered.headers, registered.target_id, [OPEN_ISSUES, DIRTY_ROOMS]
    )
    expanded = await ActivityEnvironment().run(
        activities.expand_cells, ExpandCellsInput(plan_id=plan_id)
    )
    assert len(expanded.cell_ids) == 9
    async with session_factory() as session:
        stored = await session.get(CoverageCellRow, expanded.cell_ids[0])
        assert stored is not None
        assert stored.plan_id == plan_id


async def test_smoke_generation_reports_created_then_reused_scenarios(
    activities: ScenarioPlanningActivities,
    asgi_client: httpx.AsyncClient,
    registered: RegisteredTarget,
) -> None:
    plan_id = await create_plan_through_api(
        asgi_client, registered.headers, registered.target_id, [DIRTY_ROOMS], roles=["staff"]
    )
    environment = ActivityEnvironment()
    expanded = await environment.run(activities.expand_cells, ExpandCellsInput(plan_id=plan_id))
    [cell_id] = expanded.cell_ids
    first = await environment.run(
        activities.generate_smoke_scenario, GenerateSmokeScenarioInput(cell_id=cell_id)
    )
    second = await environment.run(
        activities.generate_smoke_scenario, GenerateSmokeScenarioInput(cell_id=cell_id)
    )
    assert (first.created, first.reused) == (1, 0)
    assert (second.created, second.reused) == (0, 1)
    assert second.scenario_ids == first.scenario_ids
    validation = await environment.run(
        activities.validate_scenario, ValidateScenarioInput(scenario_id=first.scenario_ids[0])
    )
    assert validation.valid is True
    assert validation.errors == []


async def test_a_missing_cell_or_scenario_is_a_non_retryable_failure(
    activities: ScenarioPlanningActivities,
) -> None:
    environment = ActivityEnvironment()
    with pytest.raises(ApplicationError) as missing_cell:
        await environment.run(
            activities.generate_smoke_scenario, GenerateSmokeScenarioInput(cell_id=new_id())
        )
    assert missing_cell.value.non_retryable is True
    assert missing_cell.value.type == "not_found"
    with pytest.raises(ApplicationError) as missing_scenario:
        await environment.run(
            activities.validate_scenario, ValidateScenarioInput(scenario_id=new_id())
        )
    assert missing_scenario.value.non_retryable is True


async def test_run_scenarios_are_created_queued_with_k_attempts_and_pinned_versions(
    activities: ScenarioPlanningActivities,
    session_factory: SessionFactory,
    asgi_client: httpx.AsyncClient,
    registered: RegisteredTarget,
    ingest: RecordingIngest,
) -> None:
    plan_id = await prepare_plan(
        asgi_client, registered, activities, [OPEN_ISSUES, DIRTY_ROOMS, ROOMS_LIST], k=3
    )
    run_id = await create_run(session_factory, registered, plan_id)
    result = await ActivityEnvironment().run(
        activities.create_run_scenarios, CreateRunScenariosInput(run_id=run_id)
    )
    rows = await load_run_scenarios(session_factory, run_id)
    assert len(rows) == len(result.run_scenario_ids) == 9
    assert {row.id for row in rows} == set(result.run_scenario_ids)
    assert all(row.status is RunScenarioStatus.queued for row in rows)
    assert all(row.attempts_total == 3 for row in rows)
    assert all(row.scenario_version == 1 for row in rows)
    assert [entry["status"] for entry in rows[0].attempts] == ["queued"] * 3
    assert {(row.role, row.interface_id) for row in rows} >= {
        ("staff", "chat_sse"),
        ("manager", "chat_sse"),
        ("admin", "chat_sse"),
    }
    stored_run = await load_run(session_factory, run_id)
    versions = stored_run.config_snapshot["scenario_versions"]
    assert len(versions) == 9
    assert set(versions.values()) == {1}
    queued = ingest.of_type("scenario.queued")
    assert len(queued) == 9
    assert {event.payload["attempts_total"] for event in queued} == {3}
    assert ingest.of_type("scenario.finished") == []


async def test_creating_run_scenarios_twice_creates_nothing_the_second_time(
    activities: ScenarioPlanningActivities,
    session_factory: SessionFactory,
    asgi_client: httpx.AsyncClient,
    registered: RegisteredTarget,
    ingest: RecordingIngest,
) -> None:
    plan_id = await prepare_plan(asgi_client, registered, activities, [OPEN_ISSUES, DIRTY_ROOMS])
    run_id = await create_run(session_factory, registered, plan_id)
    environment = ActivityEnvironment()
    request = CreateRunScenariosInput(run_id=run_id)
    first = await environment.run(activities.create_run_scenarios, request)
    second = await environment.run(activities.create_run_scenarios, request)
    assert second.run_scenario_ids == first.run_scenario_ids
    assert len(await load_run_scenarios(session_factory, run_id)) == len(first.run_scenario_ids)
    assert len(ingest.of_type("scenario.queued")) == len(first.run_scenario_ids)


async def test_a_role_without_credentials_gets_skipped_rows_with_the_reason(
    activities: ScenarioPlanningActivities,
    session_factory: SessionFactory,
    asgi_client: httpx.AsyncClient,
    registered: RegisteredTarget,
    ingest: RecordingIngest,
) -> None:
    plan_id = await prepare_plan(asgi_client, registered, activities, [DIRTY_ROOMS])
    await clear_variables(asgi_client, registered, ["MANAGER_TOKEN"])
    run_id = await create_run(session_factory, registered, plan_id)
    await ActivityEnvironment().run(
        activities.create_run_scenarios, CreateRunScenariosInput(run_id=run_id)
    )
    rows = await load_run_scenarios(session_factory, run_id)
    by_role = {row.role: row for row in rows}
    assert by_role["manager"].status is RunScenarioStatus.skipped
    assert by_role["manager"].skip_reason is SkipReason.role_unavailable
    assert by_role["manager"].verdict is not None
    assert by_role["manager"].verdict["status"] == VerdictStatus.skipped.value
    assert by_role["manager"].verdict["skip_reason"] == "role_unavailable"
    assert by_role["manager"].finished_at is not None
    assert by_role["staff"].status is RunScenarioStatus.queued
    assert by_role["admin"].status is RunScenarioStatus.queued
    finished = ingest.of_type("scenario.finished")
    assert len(finished) == 1
    assert finished[0].payload["status"] == "skipped"
    assert finished[0].payload["verdict"]["skip_reason"] == "role_unavailable"
    assert len(ingest.of_type("scenario.queued")) == 3


async def test_a_missing_environment_value_skips_the_cells_that_need_it(
    activities: ScenarioPlanningActivities,
    session_factory: SessionFactory,
    asgi_client: httpx.AsyncClient,
    registered: RegisteredTarget,
) -> None:
    plan_id = await prepare_plan(asgi_client, registered, activities, [ROOMS_LIST])
    await clear_variables(asgi_client, registered, ["FAKE_TARGET_URL"])
    run_id = await create_run(session_factory, registered, plan_id)
    await ActivityEnvironment().run(
        activities.create_run_scenarios, CreateRunScenariosInput(run_id=run_id)
    )
    rows = await load_run_scenarios(session_factory, run_id)
    assert rows
    assert all(row.skip_reason is SkipReason.env_missing for row in rows)
    assert all(row.status is RunScenarioStatus.skipped for row in rows)


async def test_a_read_only_run_skips_write_features_as_production_blocked(
    activities: ScenarioPlanningActivities,
    session_factory: SessionFactory,
    asgi_client: httpx.AsyncClient,
    registered: RegisteredTarget,
) -> None:
    plan_id = await prepare_plan(asgi_client, registered, activities, [DIRTY_ROOMS, CREATE_ISSUE])
    run_id = await create_run(session_factory, registered, plan_id, read_only=True)
    await ActivityEnvironment().run(
        activities.create_run_scenarios, CreateRunScenariosInput(run_id=run_id)
    )
    rows = await load_run_scenarios(session_factory, run_id)
    skipped = [row for row in rows if row.status is RunScenarioStatus.skipped]
    queued = [row for row in rows if row.status is RunScenarioStatus.queued]
    assert skipped
    assert all(row.skip_reason is SkipReason.production_blocked for row in skipped)
    assert len(queued) == 3
    assert len(skipped) == 2


async def test_creating_run_scenarios_for_an_unknown_run_is_a_non_retryable_failure(
    activities: ScenarioPlanningActivities, session_factory: SessionFactory
) -> None:
    with pytest.raises(ApplicationError) as caught:
        await ActivityEnvironment().run(
            activities.create_run_scenarios, CreateRunScenariosInput(run_id=new_id())
        )
    assert caught.value.non_retryable is True


async def test_a_run_row_without_scenarios_is_left_empty(
    activities: ScenarioPlanningActivities,
    session_factory: SessionFactory,
    asgi_client: httpx.AsyncClient,
    registered: RegisteredTarget,
) -> None:
    plan_id = await create_plan_through_api(
        asgi_client, registered.headers, registered.target_id, [DIRTY_ROOMS]
    )
    run_id = await create_run(session_factory, registered, plan_id)
    environment = ActivityEnvironment()
    await environment.run(activities.expand_cells, ExpandCellsInput(plan_id=plan_id))
    result = await environment.run(
        activities.create_run_scenarios, CreateRunScenariosInput(run_id=run_id)
    )
    assert result.run_scenario_ids == []
    stored: RunRow = await load_run(session_factory, run_id)
    assert stored.config_snapshot["scenario_versions"] == {}
