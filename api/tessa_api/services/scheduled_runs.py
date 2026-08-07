import uuid
from dataclasses import dataclass

from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import RunRow, ScheduleRow
from tessa_api.db.session import SessionFactory
from tessa_api.errors import ApiError
from tessa_api.schemas.common import Budget, RunHandle
from tessa_api.schemas.enums import RunTrigger
from tessa_api.schemas.runs import RunConfigSnapshot, RunCreate
from tessa_api.schemas.schedules import ScheduledRunStarted
from tessa_api.schemas.temporal import (
    SCHEDULED_RUN_WORKFLOW,
    ScheduledRunInput,
    scheduled_run_now_workflow_id,
)
from tessa_api.services.run_origin import RunOrigin, ScheduleLink
from tessa_api.services.run_service import (
    PreparedRun,
    prepare_run,
    record_start_failure,
    run_created_event,
)
from tessa_api.services.schedule_views import get_schedule_row
from tessa_api.services.vault import Vault
from tessa_api.settings import Settings
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import append_events
from tessa_api.temporal_client import TemporalGateway

SERVICE_KEY_SCOPE_PREFIX = "service:"


@dataclass(frozen=True, slots=True)
class IdempotencyScope:
    owner_id: uuid.UUID
    key: str


async def run_now_scope(
    session: AsyncSession, user_id: uuid.UUID | None, schedule_id: uuid.UUID, key: str
) -> IdempotencyScope:
    if user_id is not None:
        return IdempotencyScope(user_id, key)
    row = await get_schedule_row(session, schedule_id)
    return IdempotencyScope(row.created_by, f"{SERVICE_KEY_SCOPE_PREFIX}{key}")


def schedule_link(row: ScheduleRow, settings: Settings) -> ScheduleLink:
    return ScheduleLink(
        schedule_id=row.id,
        tier=row.tier,
        budget=None if row.budget is None else Budget.model_validate(row.budget),
        commit_max_minutes=settings.commit_tier_max_minutes,
    )


async def prepare_scheduled_run(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    row: ScheduleRow,
    user_id: uuid.UUID,
    trigger: RunTrigger,
    run_id: uuid.UUID | None,
) -> PreparedRun:
    origin = RunOrigin(trigger=trigger, run_id=run_id, schedule=schedule_link(row, settings))
    return await prepare_run(
        session, settings, vault, user_id, RunCreate(plan_id=row.plan_id), origin
    )


async def start_run_now(
    session: AsyncSession,
    session_factory: SessionFactory,
    hub: Hub,
    temporal: TemporalGateway,
    settings: Settings,
    vault: Vault,
    schedule_id: uuid.UUID,
    user_id: uuid.UUID | None,
) -> RunHandle:
    row = await get_schedule_row(session, schedule_id)
    trigger = RunTrigger.api if user_id is None else RunTrigger.manual
    prepared = await prepare_scheduled_run(
        session, settings, vault, row, user_id or row.created_by, trigger, None
    )
    run = prepared.run
    try:
        await append_events(session_factory, hub, [run_created_event(run)])
        await temporal.start_workflow(
            SCHEDULED_RUN_WORKFLOW,
            ScheduledRunInput(schedule_id=row.id, run_id=run.id),
            scheduled_run_now_workflow_id(row.id, run.id),
        )
    except Exception:
        await record_start_failure(session_factory, hub, run)
        raise
    return prepared.handle


def run_belongs_to_schedule(run: RunRow, schedule_id: uuid.UUID) -> bool:
    try:
        return RunConfigSnapshot.model_validate(run.config_snapshot).schedule_id == schedule_id
    except ValidationError:
        return False


def started_response(run: RunRow, created: bool) -> ScheduledRunStarted:
    return ScheduledRunStarted(
        run_id=run.id, workflow_id=run.workflow_id, status=run.status, created=created
    )


def foreign_run_error(run_id: uuid.UUID) -> ApiError:
    return ApiError(409, "conflict", f"Run {run_id} already exists and belongs to another schedule")


async def start_scheduled_firing(
    session: AsyncSession,
    session_factory: SessionFactory,
    hub: Hub,
    settings: Settings,
    vault: Vault,
    schedule_id: uuid.UUID,
    run_id: uuid.UUID,
) -> ScheduledRunStarted:
    row = await get_schedule_row(session, schedule_id)
    existing = await session.get(RunRow, run_id)
    created = existing is None
    if existing is None:
        try:
            existing = (
                await prepare_scheduled_run(
                    session, settings, vault, row, row.created_by, RunTrigger.schedule, run_id
                )
            ).run
        except IntegrityError:
            await session.rollback()
            existing = await session.get(RunRow, run_id)
            created = False
            if existing is None:
                raise
    if not run_belongs_to_schedule(existing, schedule_id):
        raise foreign_run_error(run_id)
    await append_events(session_factory, hub, [run_created_event(existing)])
    return started_response(existing, created)
