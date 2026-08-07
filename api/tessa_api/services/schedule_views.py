import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import ColumnElement, and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import RunRow, ScheduleRow
from tessa_api.errors import ApiError, not_found
from tessa_api.schemas.common import Budget, RunCounters
from tessa_api.schemas.enums import RunStatus, ScheduleTier
from tessa_api.schemas.schedules import (
    Schedule,
    ScheduleDescription,
    ScheduleLastRun,
    ScheduleNotify,
    SchedulePage,
    ScheduleRunOutcome,
)
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.run_views import TERMINAL_RUN_STATUSES
from tessa_api.services.schedule_cron import next_fire_time
from tessa_api.services.schedule_rules import ScheduleValues, validate_timing

logger = logging.getLogger("tessa_api.schedules")

SCHEDULE_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(ScheduleRow.created_at, datetime)
}
SCHEDULE_ID_COLUMN = sortable(ScheduleRow.id, uuid.UUID)


class DescribingGateway(Protocol):
    async def describe_schedule(self, temporal_schedule_id: str) -> ScheduleDescription | None: ...


@dataclass(frozen=True, slots=True)
class ScheduleFilters:
    plan_id: uuid.UUID | None = None
    tiers: Sequence[ScheduleTier] = ()
    enabled: bool | None = None


async def get_schedule_row(
    session: AsyncSession, schedule_id: uuid.UUID, *, lock: bool = False
) -> ScheduleRow:
    row = await session.get(ScheduleRow, schedule_id, with_for_update=lock)
    if row is None:
        raise not_found("Schedule not found")
    return row


def schedule_run_outcome(status: RunStatus, counters: RunCounters) -> ScheduleRunOutcome:
    if status not in TERMINAL_RUN_STATUSES:
        return ScheduleRunOutcome.running
    if counters.fail > 0 or counters.flaky > 0:
        return ScheduleRunOutcome.failed
    if status is RunStatus.failed:
        return ScheduleRunOutcome.errored
    if status is RunStatus.canceled:
        return ScheduleRunOutcome.canceled
    if status is RunStatus.budget_exceeded or counters.uncertain > 0 or counters.pass_ == 0:
        return ScheduleRunOutcome.uncertain
    return ScheduleRunOutcome.passed


def to_last_run(run: RunRow) -> ScheduleLastRun:
    counters = RunCounters.model_validate(run.counters)
    return ScheduleLastRun(
        run_id=run.id,
        status=run.status,
        outcome=schedule_run_outcome(run.status, counters),
        started_at=run.started_at,
        finished_at=run.finished_at,
        counters=counters,
    )


def local_next_run(row: ScheduleRow, now: datetime | None = None) -> datetime | None:
    if not row.enabled or row.cron is None:
        return None
    try:
        timing = validate_timing(ScheduleValues.from_row(row))
    except ApiError:
        return None
    if timing.cron is None:
        return None
    return next_fire_time(timing.cron, timing.zone, now or datetime.now(UTC))


def to_schedule(
    row: ScheduleRow, next_run_at: datetime | None, last_run: RunRow | None
) -> Schedule:
    return Schedule(
        id=row.id,
        plan_id=row.plan_id,
        tier=row.tier,
        cron=row.cron,
        timezone=row.timezone,
        enabled=row.enabled,
        budget=None if row.budget is None else Budget.model_validate(row.budget),
        temporal_schedule_id=row.temporal_schedule_id,
        last_run_id=row.last_run_id,
        next_run_at=next_run_at,
        notify=ScheduleNotify.model_validate(row.notify),
        last_run=None if last_run is None else to_last_run(last_run),
    )


async def load_last_runs(
    session: AsyncSession, rows: Sequence[ScheduleRow]
) -> dict[uuid.UUID, RunRow]:
    run_ids = [row.last_run_id for row in rows if row.last_run_id is not None]
    if not run_ids:
        return {}
    found = (await session.scalars(select(RunRow).where(RunRow.id.in_(run_ids)))).all()
    return {run.id: run for run in found}


def last_run_of(row: ScheduleRow, last_runs: dict[uuid.UUID, RunRow]) -> RunRow | None:
    return None if row.last_run_id is None else last_runs.get(row.last_run_id)


def schedule_conditions(filters: ScheduleFilters) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if filters.plan_id is not None:
        conditions.append(ScheduleRow.plan_id == filters.plan_id)
    if filters.tiers:
        conditions.append(ScheduleRow.tier.in_(list(filters.tiers)))
    if filters.enabled is not None:
        conditions.append(ScheduleRow.enabled.is_(filters.enabled))
    return conditions


async def list_schedules(
    session: AsyncSession, query: PageQuery, filters: ScheduleFilters
) -> SchedulePage:
    statement = select(ScheduleRow)
    conditions = schedule_conditions(filters)
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(session, statement, SCHEDULE_SORT_COLUMNS, SCHEDULE_ID_COLUMN, query)
    rows: list[ScheduleRow] = [item[0] for item in page.rows]
    last_runs = await load_last_runs(session, rows)
    now = datetime.now(UTC)
    return SchedulePage(
        items=[
            to_schedule(row, local_next_run(row, now), last_run_of(row, last_runs)) for row in rows
        ],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def reported_next_run(gateway: DescribingGateway, row: ScheduleRow) -> datetime | None:
    fallback = local_next_run(row)
    if fallback is None:
        return None
    try:
        described = await gateway.describe_schedule(row.temporal_schedule_id)
    except ApiError:
        logger.warning("schedule_next_run_unavailable", extra={"schedule_id": str(row.id)})
        return fallback
    if described is None or described.paused or described.next_run_at is None:
        return fallback
    return described.next_run_at


async def read_schedule(
    session: AsyncSession, gateway: DescribingGateway, schedule_id: uuid.UUID
) -> Schedule:
    row = await get_schedule_row(session, schedule_id)
    last_runs = await load_last_runs(session, [row])
    return to_schedule(row, await reported_next_run(gateway, row), last_run_of(row, last_runs))
