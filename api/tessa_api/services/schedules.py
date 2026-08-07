import logging
import uuid
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import PlanRow, ScheduleRow
from tessa_api.errors import ApiError
from tessa_api.ids import new_id
from tessa_api.schemas.schedules import (
    Schedule,
    ScheduleCreate,
    ScheduleDescription,
    ScheduleSpec,
    ScheduleUpdate,
)
from tessa_api.schemas.temporal import temporal_schedule_id
from tessa_api.services.plans import get_plan_row
from tessa_api.services.schedule_rules import (
    ScheduleValues,
    apply_values,
    field_problem,
    gateway_spec,
    invalid_schedule,
    merge_update,
    spec_for,
    validate_timing,
)
from tessa_api.services.schedule_views import get_schedule_row, read_schedule
from tessa_api.services.targets import get_active_target
from tessa_api.temporal_client import ScheduleNotFoundError

logger = logging.getLogger("tessa_api.schedules")


class ScheduleGateway(Protocol):
    async def create_schedule(self, spec: ScheduleSpec) -> None: ...

    async def update_schedule(self, spec: ScheduleSpec) -> None: ...

    async def delete_schedule(self, temporal_schedule_id: str) -> None: ...

    async def pause_schedule(self, temporal_schedule_id: str) -> None: ...

    async def unpause_schedule(self, temporal_schedule_id: str) -> None: ...

    async def trigger_schedule(self, temporal_schedule_id: str) -> None: ...

    async def describe_schedule(self, temporal_schedule_id: str) -> ScheduleDescription | None: ...


async def load_schedulable_plan(session: AsyncSession, plan_id: uuid.UUID) -> PlanRow:
    plan = await get_plan_row(session, plan_id)
    if plan.is_coverage_baseline:
        raise invalid_schedule(
            [
                field_problem(
                    "plan_id",
                    "plan_not_schedulable",
                    "The hidden coverage baseline plan is managed by Tessa and cannot be "
                    "scheduled",
                )
            ]
        )
    await get_active_target(session, plan.target_id)
    return plan


async def newest_schedule_id(
    session: AsyncSession, plan_id: uuid.UUID, excluding: uuid.UUID
) -> uuid.UUID | None:
    return await session.scalar(
        select(ScheduleRow.id)
        .where(ScheduleRow.plan_id == plan_id, ScheduleRow.id != excluding)
        .order_by(ScheduleRow.created_at.desc(), ScheduleRow.id.desc())
        .limit(1)
    )


async def discard_temporal_schedule(gateway: ScheduleGateway, temporal_id: str) -> None:
    try:
        await gateway.delete_schedule(temporal_id)
    except Exception:
        logger.exception(
            "schedule_compensation_failed", extra={"temporal_schedule_id": temporal_id}
        )


async def restore_temporal_schedule(gateway: ScheduleGateway, spec: ScheduleSpec) -> None:
    try:
        await gateway.update_schedule(spec)
    except ScheduleNotFoundError:
        await recreate_temporal_schedule(gateway, spec)
    except Exception:
        logger.exception(
            "schedule_compensation_failed",
            extra={"temporal_schedule_id": spec.temporal_schedule_id},
        )


async def recreate_temporal_schedule(gateway: ScheduleGateway, spec: ScheduleSpec) -> None:
    try:
        await gateway.create_schedule(spec)
    except Exception:
        logger.exception(
            "schedule_compensation_failed",
            extra={"temporal_schedule_id": spec.temporal_schedule_id},
        )


async def create_in_temporal(gateway: ScheduleGateway, spec: ScheduleSpec) -> None:
    try:
        await gateway.create_schedule(spec)
    except Exception:
        await discard_temporal_schedule(gateway, spec.temporal_schedule_id)
        raise


def temporal_change_needed(previous: ScheduleSpec | None, new: ScheduleSpec) -> str | None:
    if previous is None or (previous.cron, previous.timezone) != (new.cron, new.timezone):
        return "spec"
    if previous.paused != new.paused:
        return "pause"
    return None


async def apply_to_temporal(
    gateway: ScheduleGateway, previous: ScheduleSpec | None, new: ScheduleSpec
) -> None:
    change = temporal_change_needed(previous, new)
    try:
        if change == "spec":
            await gateway.update_schedule(new)
        elif change == "pause":
            if new.paused:
                await gateway.pause_schedule(new.temporal_schedule_id)
            else:
                await gateway.unpause_schedule(new.temporal_schedule_id)
    except ScheduleNotFoundError:
        await gateway.create_schedule(new)


def new_schedule_row(
    schedule_id: uuid.UUID, plan: PlanRow, user_id: uuid.UUID, values: ScheduleValues
) -> ScheduleRow:
    row = ScheduleRow(
        id=schedule_id,
        plan_id=plan.id,
        temporal_schedule_id=temporal_schedule_id(schedule_id),
        created_by=user_id,
    )
    apply_values(row, values)
    return row


async def create_schedule(
    session: AsyncSession, gateway: ScheduleGateway, user_id: uuid.UUID, body: ScheduleCreate
) -> Schedule:
    plan = await load_schedulable_plan(session, body.plan_id)
    values = ScheduleValues.from_create(body)
    timing = validate_timing(values)
    schedule_id = new_id()
    spec = spec_for(schedule_id, values, timing)
    session.add(new_schedule_row(schedule_id, plan, user_id, values))
    await session.flush()
    plan.schedule_id = schedule_id
    await session.flush()
    await create_in_temporal(gateway, spec)
    try:
        await session.commit()
    except Exception:
        await discard_temporal_schedule(gateway, spec.temporal_schedule_id)
        raise
    return await read_schedule(session, gateway, schedule_id)


def previous_spec_of(row: ScheduleRow) -> ScheduleSpec | None:
    try:
        return gateway_spec(row)
    except ApiError:
        return None


async def restore_previous(gateway: ScheduleGateway, previous: ScheduleSpec | None) -> None:
    if previous is not None:
        await restore_temporal_schedule(gateway, previous)


async def update_schedule(
    session: AsyncSession, gateway: ScheduleGateway, schedule_id: uuid.UUID, body: ScheduleUpdate
) -> Schedule:
    row = await get_schedule_row(session, schedule_id, lock=True)
    previous = previous_spec_of(row)
    updated = merge_update(ScheduleValues.from_row(row), body)
    new_spec = spec_for(row.id, updated, validate_timing(updated))
    try:
        await apply_to_temporal(gateway, previous, new_spec)
    except Exception:
        await restore_previous(gateway, previous)
        raise
    apply_values(row, updated)
    try:
        await session.commit()
    except Exception:
        await restore_previous(gateway, previous)
        raise
    return await read_schedule(session, gateway, schedule_id)


async def repoint_plan(session: AsyncSession, row: ScheduleRow) -> None:
    plan = await session.get(PlanRow, row.plan_id, with_for_update=True)
    if plan is None or plan.schedule_id != row.id:
        return
    plan.schedule_id = await newest_schedule_id(session, plan.id, row.id)
    await session.flush()


async def delete_schedule(
    session: AsyncSession, gateway: ScheduleGateway, schedule_id: uuid.UUID
) -> None:
    unlocked = await get_schedule_row(session, schedule_id)
    await session.get(PlanRow, unlocked.plan_id, with_for_update=True)
    row = await get_schedule_row(session, schedule_id, lock=True)
    previous = previous_spec_of(row)
    await gateway.delete_schedule(row.temporal_schedule_id)
    try:
        await repoint_plan(session, row)
        await session.delete(row)
        await session.commit()
    except Exception:
        if previous is not None:
            await recreate_temporal_schedule(gateway, previous)
        raise
