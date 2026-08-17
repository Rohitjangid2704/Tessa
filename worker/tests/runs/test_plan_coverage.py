from uuid import UUID

import pytest
from temporalio.client import WorkflowHandle
from temporalio.testing import WorkflowEnvironment

from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.temporal import (
    PLAN_COVERAGE_WORKFLOW,
    PROGRESS_QUERY,
    PlanCoverageInput,
    PlanCoverageProgress,
    PlanCoverageResult,
    plan_coverage_workflow_id,
)
from tessa_worker.settings import WorkerSettings
from tests.runs.harness import TASK_QUEUE, StubPlanning, run_stack
from tests.runs.support import RecordingIngest, seed_run

pytestmark = pytest.mark.integration


async def start_coverage(
    stack_environment: WorkflowEnvironment, run_id: UUID, request: PlanCoverageInput
) -> WorkflowHandle[object, PlanCoverageResult]:
    return await stack_environment.client.start_workflow(
        PLAN_COVERAGE_WORKFLOW,
        request,
        id=plan_coverage_workflow_id(run_id),
        task_queue=TASK_QUEUE,
        result_type=PlanCoverageResult,
    )


async def test_every_cell_is_generated_and_every_scenario_validated(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=0)
    cells = [new_id() for _ in range(5)]
    planning = StubPlanning(cell_ids=cells, scenario_ids_per_cell=2, reused_cells=set(cells[:2]))
    async with run_stack(temporal_env, session_factory, worker_settings, ingest, planning=planning):
        handle = await start_coverage(
            temporal_env,
            seeded.run_id,
            PlanCoverageInput(plan_id=seeded.plan_id, run_id=seeded.run_id),
        )
        result = await handle.result()
        progress = await handle.query(PROGRESS_QUERY, result_type=PlanCoverageProgress)
    assert result == PlanCoverageResult(
        cells_total=5, scenarios_created=6, scenarios_reused=4, scenarios_invalid=0
    )
    assert sorted(planning.generated) == sorted(cells)
    assert len(planning.validated) == 10
    assert progress.cells_done == 5
    assert progress.cells_total == 5


async def test_invalid_scenarios_are_counted_not_fatal(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=0)
    cells = [new_id() for _ in range(3)]
    invalid = {UUID(int=cells[1].int + 1)}
    planning = StubPlanning(cell_ids=cells, invalid_scenario_ids=invalid)
    async with run_stack(temporal_env, session_factory, worker_settings, ingest, planning=planning):
        handle = await start_coverage(
            temporal_env,
            seeded.run_id,
            PlanCoverageInput(plan_id=seeded.plan_id, run_id=seeded.run_id),
        )
        result = await handle.result()
    assert result.cells_total == 3
    assert result.scenarios_invalid == 1


async def test_a_run_can_limit_planning_to_some_cells(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=0)
    cells = [new_id() for _ in range(4)]
    planning = StubPlanning(cell_ids=cells)
    async with run_stack(temporal_env, session_factory, worker_settings, ingest, planning=planning):
        handle = await start_coverage(
            temporal_env,
            seeded.run_id,
            PlanCoverageInput(
                plan_id=seeded.plan_id, run_id=seeded.run_id, cell_ids=[cells[0], cells[3]]
            ),
        )
        result = await handle.result()
    assert result.cells_total == 2
    assert sorted(planning.generated) == sorted([cells[0], cells[3]])


async def test_a_plan_without_cells_plans_nothing(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=0)
    planning = StubPlanning(cell_ids=[])
    async with run_stack(temporal_env, session_factory, worker_settings, ingest, planning=planning):
        handle = await start_coverage(
            temporal_env,
            seeded.run_id,
            PlanCoverageInput(plan_id=seeded.plan_id, run_id=seeded.run_id),
        )
        result = await handle.result()
    assert result == PlanCoverageResult(
        cells_total=0, scenarios_created=0, scenarios_reused=0, scenarios_invalid=0
    )
    assert planning.generated == []
