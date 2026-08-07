from datetime import datetime
from uuid import UUID

from sqlalchemy import ColumnElement, and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import RunRow
from tessa_api.schemas.enums import RunKind, TrendMetric
from tessa_api.schemas.run_stats import RunStats
from tessa_api.schemas.trends import TrendPoint, TrendSeries
from tessa_api.services.targets import get_target

MAX_TREND_POINTS = 500


def metric_value(metric: TrendMetric, stats: RunStats) -> float | None:
    match metric:
        case TrendMetric.pass_hat_k:
            return stats.pass_hat_k
        case TrendMetric.open_findings:
            return float(stats.open_findings)
        case TrendMetric.cost_usd:
            return stats.cost_usd.total
        case TrendMetric.latency_p50_ms:
            return float(stats.latency_ms.p50)
        case TrendMetric.flaky_rate:
            return stats.flaky_rate


def trend_conditions(
    target_id: UUID, since: datetime | None, until: datetime | None, plan_id: UUID | None
) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = [
        RunRow.target_id == target_id,
        RunRow.kind == RunKind.suite,
        RunRow.stats.is_not(None),
        RunRow.finished_at.is_not(None),
        RunRow.config_snapshot["scenario_ids"].astext.is_(None),
    ]
    if since is not None:
        conditions.append(RunRow.finished_at >= since)
    if until is not None:
        conditions.append(RunRow.finished_at <= until)
    if plan_id is not None:
        conditions.append(RunRow.plan_id == plan_id)
    return conditions


async def read_trend(
    session: AsyncSession,
    target_id: UUID,
    metric: TrendMetric,
    since: datetime | None,
    until: datetime | None,
    plan_id: UUID | None,
) -> TrendSeries:
    await get_target(session, target_id)
    rows = await session.execute(
        select(RunRow.id, RunRow.finished_at, RunRow.stats)
        .where(and_(*trend_conditions(target_id, since, until, plan_id)))
        .order_by(RunRow.finished_at.desc(), RunRow.id.desc())
        .limit(MAX_TREND_POINTS)
    )
    points: list[TrendPoint] = []
    for run_id, finished_at, stored in rows:
        if stored is None or finished_at is None:
            continue
        value = metric_value(metric, RunStats.model_validate(stored))
        if value is not None:
            points.append(TrendPoint(ts=finished_at, value=value, run_id=run_id))
    return TrendSeries(metric=metric, points=list(reversed(points)))
