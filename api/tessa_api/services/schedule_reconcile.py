import asyncio
import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from pydantic import ValidationError
from sqlalchemy import select

from tessa_api.db.models import ScheduleRow
from tessa_api.db.session import SessionFactory
from tessa_api.errors import ApiError
from tessa_api.schemas.enums import NotificationKind, Severity
from tessa_api.schemas.notifications import NotificationDraft
from tessa_api.schemas.schedules import ScheduleDescription, ScheduleSpec
from tessa_api.services.notifications import NotificationEvents, create_notification_row
from tessa_api.services.schedule_cron import next_fire_time
from tessa_api.services.schedule_rules import (
    ScheduleValues,
    ValidatedTiming,
    spec_for,
    validate_timing,
)
from tessa_api.services.schedules import ScheduleGateway
from tessa_api.temporal_client import ScheduleNotFoundError

logger = logging.getLogger("tessa_api.schedules")

RECONCILE_ATTEMPTS = 3
RECONCILE_RETRY_SECONDS = 20.0
RECONCILE_DEADLINE_SECONDS = 180.0
NEXT_FIRE_TOLERANCE = timedelta(minutes=1)
SCHEDULES_LINK = "/catalog?tab=plans"
DEFAULT_ZONE_NAME = "UTC"


@dataclass(frozen=True, slots=True)
class ScheduleProblem:
    schedule_id: uuid.UUID
    summary: str
    repaired: bool


@dataclass(frozen=True, slots=True)
class ReconcilePass:
    checked: int
    repaired: list[ScheduleProblem]
    failed: list[ScheduleProblem]


def cron_drift(
    spec: ScheduleSpec,
    described: ScheduleDescription,
    timing: ValidatedTiming,
    now: datetime,
) -> str | None:
    if spec.cron is None:
        fires = not described.paused and described.next_run_at is not None
        if described.cron is not None or fires:
            return "the Temporal schedule fires on its own but the schedule has no cron"
        return None
    if described.cron is not None:
        return None if described.cron == spec.cron else "the Temporal cron differs"
    if described.paused or timing.cron is None:
        return None
    expected = next_fire_time(timing.cron, timing.zone, now)
    if expected is None or described.next_run_at is None:
        return "the Temporal schedule has no next firing"
    if abs(described.next_run_at - expected) > NEXT_FIRE_TOLERANCE:
        return "the next Temporal firing differs from the cron"
    return None


def spec_drift(
    spec: ScheduleSpec,
    described: ScheduleDescription,
    timing: ValidatedTiming,
    now: datetime,
) -> str | None:
    if described.paused != spec.paused:
        state = "paused" if described.paused else "running"
        wanted = "disabled" if spec.paused else "enabled"
        return f"the Temporal schedule is {state} but the schedule is {wanted}"
    if (described.timezone or DEFAULT_ZONE_NAME) != spec.timezone:
        return "the Temporal time zone differs"
    return cron_drift(spec, described, timing, now)


async def repair(gateway: ScheduleGateway, spec: ScheduleSpec, missing: bool) -> None:
    if missing:
        await gateway.create_schedule(spec)
        return
    try:
        await gateway.update_schedule(spec)
    except ScheduleNotFoundError:
        await gateway.create_schedule(spec)


async def reconcile_row(gateway: ScheduleGateway, row: ScheduleRow) -> ScheduleProblem | None:
    try:
        values = ScheduleValues.from_row(row)
        timing = validate_timing(values)
    except ApiError as error:
        return ScheduleProblem(row.id, f"the stored schedule is invalid: {error.message}", False)
    except ValidationError:
        return ScheduleProblem(
            row.id, "the stored schedule has an unreadable budget or notify", False
        )
    spec = spec_for(row.id, values, timing)
    try:
        described = await gateway.describe_schedule(row.temporal_schedule_id)
        drift = (
            "the Temporal schedule is missing"
            if described is None
            else spec_drift(spec, described, timing, datetime.now(UTC))
        )
        if drift is None:
            return None
        await repair(gateway, spec, described is None)
    except (ApiError, ScheduleNotFoundError) as error:
        reason = error.message if isinstance(error, ApiError) else str(error)
        return ScheduleProblem(row.id, f"could not verify or repair the schedule: {reason}", False)
    return ScheduleProblem(row.id, f"{drift}; it was repaired", True)


async def load_rows(
    session_factory: SessionFactory, only: set[uuid.UUID] | None
) -> list[ScheduleRow]:
    statement = select(ScheduleRow).order_by(ScheduleRow.created_at, ScheduleRow.id)
    if only is not None:
        statement = statement.where(ScheduleRow.id.in_(only))
    async with session_factory() as session:
        return list((await session.scalars(statement)).all())


async def reconcile_pass(
    session_factory: SessionFactory, gateway: ScheduleGateway, only: set[uuid.UUID] | None
) -> ReconcilePass:
    rows = await load_rows(session_factory, only)
    repaired: list[ScheduleProblem] = []
    failed: list[ScheduleProblem] = []
    for row in rows:
        try:
            problem = await reconcile_row(gateway, row)
        except Exception as error:
            logger.exception("schedule_reconcile_row_failed", extra={"schedule_id": str(row.id)})
            problem = ScheduleProblem(row.id, f"unexpected {type(error).__name__}", False)
        if problem is None:
            continue
        logger.warning(
            "schedule_out_of_sync",
            extra={
                "schedule_id": str(problem.schedule_id),
                "summary": problem.summary,
                "repaired": problem.repaired,
            },
        )
        (repaired if problem.repaired else failed).append(problem)
    return ReconcilePass(checked=len(rows), repaired=repaired, failed=failed)


def problem_draft(problem: ScheduleProblem) -> NotificationDraft:
    return NotificationDraft(
        kind=NotificationKind.schedule_failed,
        severity=Severity.medium if problem.repaired else Severity.high,
        title="A schedule was out of sync with Temporal"
        if problem.repaired
        else "A schedule could not be checked against Temporal",
        body=f"Schedule {problem.schedule_id}: {problem.summary}",
        link=SCHEDULES_LINK,
        run_id=None,
        user_id=None,
    )


async def notify_problems(
    session_factory: SessionFactory,
    events: NotificationEvents | None,
    problems: Sequence[ScheduleProblem],
) -> None:
    for problem in problems:
        try:
            async with session_factory() as session:
                await create_notification_row(session, problem_draft(problem), events)
        except Exception:
            logger.exception(
                "schedule_notification_failed", extra={"schedule_id": str(problem.schedule_id)}
            )


async def reconcile_schedules(
    session_factory: SessionFactory,
    gateway: ScheduleGateway,
    events: NotificationEvents | None,
) -> None:
    pending: set[uuid.UUID] | None = None
    for attempt in range(1, RECONCILE_ATTEMPTS + 1):
        outcome = await reconcile_pass(session_factory, gateway, pending)
        await notify_problems(session_factory, events, outcome.repaired)
        if not outcome.failed:
            logger.info("schedules_reconciled", extra={"checked": outcome.checked})
            return
        if attempt == RECONCILE_ATTEMPTS:
            await notify_problems(session_factory, events, outcome.failed)
            return
        pending = {problem.schedule_id for problem in outcome.failed}
        await asyncio.sleep(RECONCILE_RETRY_SECONDS)


async def run_schedule_reconcile(
    session_factory: SessionFactory,
    gateway: ScheduleGateway,
    events: NotificationEvents | None,
) -> None:
    try:
        async with asyncio.timeout(RECONCILE_DEADLINE_SECONDS):
            await reconcile_schedules(session_factory, gateway, events)
    except TimeoutError:
        logger.warning("schedule_reconcile_timed_out")
    except Exception:
        logger.exception("schedule_reconcile_failed")
