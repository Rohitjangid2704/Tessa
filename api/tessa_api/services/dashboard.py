import uuid
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import FindingRow, RunRow
from tessa_api.schemas.dashboard import DashboardSummary, LastNightly, SeverityCounts
from tessa_api.schemas.enums import RunKind, ScheduleTier, Severity
from tessa_api.schemas.run_stats import RunStats
from tessa_api.schemas.runs import RunSummary
from tessa_api.services.calibration import build_calibration_report, overall_kappa
from tessa_api.services.mutation_summary import summarize_mutation
from tessa_api.services.run_stats import OPEN_FINDING_STATUSES
from tessa_api.services.run_views import to_run_summary
from tessa_api.settings import Settings

COST_WINDOW = timedelta(days=7)
COST_DECIMALS = 6
LAST_RUNS_LIMIT = 10
NOT_SHOWN_RUN_KINDS = (RunKind.hello,)


def run_scope(target_id: uuid.UUID | None) -> list[ColumnElement[bool]]:
    return [] if target_id is None else [RunRow.target_id == target_id]


def pass_hat_k_of(stats: Mapping[str, Any] | None) -> float | None:
    return None if stats is None else RunStats.model_validate(stats).pass_hat_k


async def read_last_nightly(
    session: AsyncSession, target_id: uuid.UUID | None
) -> LastNightly | None:
    row = (
        await session.execute(
            select(RunRow.id, RunRow.finished_at, RunRow.stats)
            .where(
                RunRow.kind == RunKind.suite,
                RunRow.finished_at.is_not(None),
                RunRow.config_snapshot["schedule_tier"].astext == ScheduleTier.nightly.value,
                *run_scope(target_id),
            )
            .order_by(RunRow.finished_at.desc(), RunRow.id.desc())
            .limit(1)
        )
    ).one_or_none()
    if row is None or row.finished_at is None:
        return None
    return LastNightly(
        run_id=row.id, pass_hat_k=pass_hat_k_of(row.stats), finished_at=row.finished_at
    )


async def read_open_findings(session: AsyncSession, target_id: uuid.UUID | None) -> SeverityCounts:
    statement = (
        select(FindingRow.severity, func.count())
        .where(FindingRow.status.in_(list(OPEN_FINDING_STATUSES)))
        .group_by(FindingRow.severity)
    )
    if target_id is not None:
        statement = statement.where(FindingRow.target_id == target_id)
    counts = dict.fromkeys(Severity, 0)
    for severity, count in await session.execute(statement):
        counts[severity] = int(count)
    return SeverityCounts(**{severity.value: count for severity, count in counts.items()})


async def read_cost_week(
    session: AsyncSession, target_id: uuid.UUID | None, now: datetime
) -> float:
    total = await session.scalar(
        select(func.coalesce(func.sum(RunRow.spent_usd), 0)).where(
            RunRow.created_at >= now - COST_WINDOW, *run_scope(target_id)
        )
    )
    return round(float(total or 0), COST_DECIMALS)


async def read_last_runs(
    session: AsyncSession, target_id: uuid.UUID | None, now: datetime
) -> list[RunSummary]:
    rows = await session.scalars(
        select(RunRow)
        .where(RunRow.kind.not_in(NOT_SHOWN_RUN_KINDS), *run_scope(target_id))
        .order_by(RunRow.created_at.desc(), RunRow.id.desc())
        .limit(LAST_RUNS_LIMIT)
    )
    return [to_run_summary(row, now) for row in rows]


async def build_dashboard(
    session: AsyncSession, settings: Settings, target_id: uuid.UUID | None
) -> DashboardSummary:
    now = datetime.now(UTC)
    mutation = await summarize_mutation(session, target_id)
    calibration = await build_calibration_report(session, settings, target_id)
    return DashboardSummary(
        last_nightly=await read_last_nightly(session, target_id),
        open_findings_by_severity=await read_open_findings(session, target_id),
        cost_week_usd=await read_cost_week(session, target_id, now),
        suite_power=mutation.suite_power,
        kappa=overall_kappa(calibration),
        last_runs=await read_last_runs(session, target_id, now),
    )
