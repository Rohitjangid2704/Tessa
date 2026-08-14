from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import CoverageCellRow, PlanRow, RunRow, RunScenarioRow, ScenarioRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import Budget
from tessa_api.schemas.enums import RunScenarioStatus
from tessa_api.schemas.plans import Plan, PlanSelection
from tessa_api.schemas.runs import RunConfigSnapshot
from tessa_api.schemas.temporal import (
    LOAD_RUN_CONTEXT_ACTIVITY,
    LoadRunContextInput,
    RunContext,
    RunScenarioRef,
)
from tessa_api.services.settings_service import effective_settings
from tessa_worker.settings import WorkerSettings


def scenario_timeout_seconds(parsed: dict[str, object], default_seconds: int) -> int:
    declared = parsed.get("timeout_seconds")
    if isinstance(declared, int) and not isinstance(declared, bool) and declared >= 1:
        return declared
    return default_seconds


def to_plan(row: PlanRow, cells_total: int) -> Plan:
    return Plan(
        id=row.id,
        target_id=row.target_id,
        bundle_id=row.bundle_id,
        name=row.name,
        saved=row.saved,
        selection=PlanSelection.model_validate(row.selection),
        effective_budget=Budget.model_validate(row.budget),
        is_coverage_baseline=False,
        include_api_fuzz=row.include_api_fuzz,
        cells_total=cells_total,
        schedule_id=None,
        created_by=row.created_by,
        created_at=row.created_at,
    )


async def read_plan(session: AsyncSession, plan_id: UUID) -> Plan:
    row = await session.get(PlanRow, plan_id)
    if row is None:
        raise ApplicationError(f"plan {plan_id} does not exist", non_retryable=True)
    cells_total = await session.scalar(
        select(func.count()).select_from(CoverageCellRow).where(CoverageCellRow.plan_id == plan_id)
    )
    return to_plan(row, cells_total or 0)


class RunContextActivities:
    def __init__(self, session_factory: SessionFactory, settings: WorkerSettings) -> None:
        self.session_factory = session_factory
        self.settings = settings

    @activity.defn(name=LOAD_RUN_CONTEXT_ACTIVITY)
    async def load_run_context(self, request: LoadRunContextInput) -> RunContext:
        async with self.session_factory() as session:
            run = await session.get(RunRow, request.run_id)
            if run is None:
                raise ApplicationError(f"run {request.run_id} does not exist", non_retryable=True)
            if run.plan_id is None:
                raise ApplicationError(f"run {request.run_id} has no plan", non_retryable=True)
            plan = await read_plan(session, run.plan_id)
            effective = await effective_settings(session, self.settings)
            queued = await session.execute(
                select(RunScenarioRow.id, RunScenarioRow.attempts_total, ScenarioRow.parsed)
                .join(ScenarioRow, ScenarioRow.id == RunScenarioRow.scenario_id)
                .where(
                    RunScenarioRow.run_id == request.run_id,
                    RunScenarioRow.status == RunScenarioStatus.queued,
                )
                .order_by(RunScenarioRow.created_at, RunScenarioRow.id)
            )
            run_scenarios = [
                RunScenarioRef(
                    id=run_scenario_id,
                    attempts_total=attempts_total,
                    timeout_seconds=scenario_timeout_seconds(
                        parsed, self.settings.scenario_timeout_seconds
                    ),
                )
                for run_scenario_id, attempts_total, parsed in queued
            ]
            return RunContext(
                config_snapshot=RunConfigSnapshot.model_validate(run.config_snapshot),
                plan=plan,
                run_scenarios=run_scenarios,
                read_only=run.read_only,
                max_concurrency=effective.run_max_concurrency,
                budget=Budget.model_validate(run.budget),
            )
