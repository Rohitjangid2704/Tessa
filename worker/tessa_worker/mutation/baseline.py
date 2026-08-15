import uuid
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, RunRow, RunScenarioRow
from tessa_api.ids import new_id
from tessa_api.schemas.enums import RunKind, RunScenarioStatus, RunStatus, RunTrigger
from tessa_api.schemas.runs import RunConfigSnapshot
from tessa_api.schemas.temporal import execute_run_workflow_id
from tessa_api.services.hello import zero_run_counters
from tessa_api.services.run_service import initial_config_snapshot


async def find_reusable_baseline(
    session: AsyncSession, run: RunRow, now: datetime, max_age_hours: int
) -> RunRow | None:
    snapshot = RunConfigSnapshot.model_validate(run.config_snapshot)
    has_finished_scenario = (
        select(RunScenarioRow.id)
        .where(
            RunScenarioRow.run_id == RunRow.id, RunScenarioRow.status == RunScenarioStatus.finished
        )
        .exists()
    )
    return await session.scalar(
        select(RunRow)
        .where(
            RunRow.kind == RunKind.suite,
            RunRow.target_id == run.target_id,
            RunRow.plan_id == run.plan_id,
            RunRow.status == RunStatus.completed,
            RunRow.read_only.is_(False),
            RunRow.finished_at >= now - timedelta(hours=max_age_hours),
            RunRow.config_snapshot["bundle_version"].astext == str(snapshot.bundle_version),
            RunRow.config_snapshot["base_url_override"].astext.is_(None),
            has_finished_scenario,
        )
        .order_by(RunRow.finished_at.desc())
        .limit(1)
    )


def new_baseline_run(run: RunRow, bundle: BundleRow, created_at: datetime) -> RunRow:
    baseline_id = new_id()
    return RunRow(
        id=baseline_id,
        kind=RunKind.suite,
        target_id=run.target_id,
        plan_id=run.plan_id,
        bundle_id=bundle.id,
        status=RunStatus.queued,
        trigger=RunTrigger.api,
        read_only=False,
        config_snapshot=initial_config_snapshot(bundle).model_dump(mode="json"),
        budget=run.budget,
        counters=zero_run_counters().model_dump(mode="json"),
        workflow_id=execute_run_workflow_id(baseline_id),
        created_by=run.created_by,
        created_at=created_at,
    )


async def baseline_is_finished(session: AsyncSession, baseline_run_id: uuid.UUID) -> bool:
    status = await session.scalar(select(RunRow.status).where(RunRow.id == baseline_run_id))
    return status is RunStatus.completed
