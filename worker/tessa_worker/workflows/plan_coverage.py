import asyncio
from uuid import UUID

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.scenarios import ScenarioValidation
    from tessa_api.schemas.temporal import (
        CANCEL_SIGNAL,
        EXPAND_CELLS_ACTIVITY,
        GENERATE_SMOKE_SCENARIO_ACTIVITY,
        PLAN_COVERAGE_WORKFLOW,
        PROGRESS_QUERY,
        VALIDATE_SCENARIO_ACTIVITY,
        ExpandCellsInput,
        ExpandCellsResult,
        GenerateSmokeScenarioInput,
        PlanCoverageInput,
        PlanCoverageProgress,
        PlanCoverageResult,
        ValidateScenarioInput,
    )
    from tessa_worker.activities.run_models import GenerateSmokeScenarioOutcome
    from tessa_worker.workflows.authored_dry_run import AuthoredDryRun
    from tessa_worker.workflows.calls import call_activity

CELL_CONCURRENCY = 8


def select_cells(expanded: list[UUID], restricted_to: list[UUID] | None) -> list[UUID]:
    if restricted_to is None:
        return expanded
    wanted = set(restricted_to)
    return [cell_id for cell_id in expanded if cell_id in wanted]


@workflow.defn(name=PLAN_COVERAGE_WORKFLOW)
class PlanCoverageWorkflow:
    def __init__(self) -> None:
        self.cells_total = 0
        self.cells_done = 0
        self.scenarios_created = 0
        self.scenarios_reused = 0
        self.scenarios_invalid = 0
        self.cancel_requested = False
        self.dry_run: AuthoredDryRun | None = None

    @workflow.signal(name=CANCEL_SIGNAL)
    def cancel(self) -> None:
        self.cancel_requested = True

    def is_cancel_requested(self) -> bool:
        return self.cancel_requested

    @workflow.query(name=PROGRESS_QUERY)
    def progress(self) -> PlanCoverageProgress:
        if self.dry_run is not None:
            return self.dry_run.progress()
        return PlanCoverageProgress(
            cells_total=self.cells_total,
            cells_done=self.cells_done,
            scenarios_created=self.scenarios_created,
            scenarios_reused=self.scenarios_reused,
            scenarios_invalid=self.scenarios_invalid,
        )

    @workflow.run
    async def run(self, request: PlanCoverageInput) -> PlanCoverageResult:
        if request.mode == "dry_run":
            self.dry_run = AuthoredDryRun(request, self.is_cancel_requested)
            return await self.dry_run.run()
        return await self.run_smoke(request)

    async def run_smoke(self, request: PlanCoverageInput) -> PlanCoverageResult:
        expanded = await call_activity(
            EXPAND_CELLS_ACTIVITY, ExpandCellsInput(plan_id=request.plan_id), ExpandCellsResult
        )
        cell_ids = select_cells(expanded.cell_ids, request.cell_ids)
        self.cells_total = len(cell_ids)
        slots = asyncio.Semaphore(CELL_CONCURRENCY)
        await asyncio.gather(*(self.plan_cell(cell_id, slots) for cell_id in cell_ids))
        return PlanCoverageResult(
            cells_total=self.cells_total,
            scenarios_created=self.scenarios_created,
            scenarios_reused=self.scenarios_reused,
            scenarios_invalid=self.scenarios_invalid,
        )

    async def plan_cell(self, cell_id: UUID, slots: asyncio.Semaphore) -> None:
        async with slots:
            generated = await call_activity(
                GENERATE_SMOKE_SCENARIO_ACTIVITY,
                GenerateSmokeScenarioInput(cell_id=cell_id),
                GenerateSmokeScenarioOutcome,
            )
            for scenario_id in generated.scenario_ids:
                validation = await call_activity(
                    VALIDATE_SCENARIO_ACTIVITY,
                    ValidateScenarioInput(scenario_id=scenario_id),
                    ScenarioValidation,
                )
                if not validation.valid:
                    self.scenarios_invalid += 1
            self.scenarios_created += generated.created
            self.scenarios_reused += generated.reused
            self.cells_done += 1
