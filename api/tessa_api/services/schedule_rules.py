from collections.abc import Sequence
from dataclasses import dataclass
from typing import Self
from uuid import UUID
from zoneinfo import ZoneInfo

from tessa_api.db.models import ScheduleRow
from tessa_api.errors import ApiError
from tessa_api.schemas.common import Budget, ErrorDetail
from tessa_api.schemas.enums import ScheduleTier
from tessa_api.schemas.schedules import (
    ScheduleCreate,
    ScheduleNotify,
    ScheduleSpec,
    ScheduleUpdate,
)
from tessa_api.schemas.temporal import temporal_schedule_id
from tessa_api.services.schedule_cron import (
    CronError,
    CronSchedule,
    load_timezone,
    parse_cron,
)

BODY_LOCATION = ("body",)
CRON_TIERS = (ScheduleTier.nightly, ScheduleTier.weekly)


@dataclass(frozen=True, slots=True)
class ScheduleValues:
    tier: ScheduleTier
    cron: str | None
    timezone: str
    enabled: bool
    budget: Budget | None
    notify: ScheduleNotify

    @classmethod
    def from_create(cls, body: ScheduleCreate) -> Self:
        return cls(
            tier=body.tier,
            cron=normalised_cron(body.cron),
            timezone=body.timezone,
            enabled=body.enabled,
            budget=body.budget,
            notify=normalised_notify(body.notify),
        )

    @classmethod
    def from_row(cls, row: ScheduleRow) -> Self:
        return cls(
            tier=row.tier,
            cron=row.cron,
            timezone=row.timezone,
            enabled=row.enabled,
            budget=None if row.budget is None else Budget.model_validate(row.budget),
            notify=ScheduleNotify.model_validate(row.notify),
        )


@dataclass(frozen=True, slots=True)
class ValidatedTiming:
    cron: CronSchedule | None
    zone: ZoneInfo


def normalised_cron(cron: str | None) -> str | None:
    if cron is None:
        return None
    collapsed = " ".join(cron.split())
    return collapsed or None


def normalised_notify(notify: ScheduleNotify) -> ScheduleNotify:
    return ScheduleNotify(slack=notify.slack)


def invalid_schedule(problems: Sequence[ErrorDetail]) -> ApiError:
    return ApiError(422, "validation_failed", "Request validation failed", list(problems))


def field_problem(field: str, code: str, message: str) -> ErrorDetail:
    return ErrorDetail(loc=[*BODY_LOCATION, field], code=code, message=message)


def tier_problems(tier: ScheduleTier, cron: str | None) -> list[ErrorDetail]:
    if tier is ScheduleTier.commit and cron is not None:
        return [
            field_problem(
                "cron",
                "cron_not_allowed",
                "The commit tier has no cron; it runs through run-now from your CI",
            )
        ]
    if tier in CRON_TIERS and cron is None:
        return [field_problem("cron", "cron_required", f"The {tier.value} tier needs a cron")]
    return []


def validate_timing(values: ScheduleValues) -> ValidatedTiming:
    problems = tier_problems(values.tier, values.cron)
    schedule: CronSchedule | None = None
    zone: ZoneInfo | None = None
    if values.cron is not None and not problems:
        try:
            schedule = parse_cron(values.cron)
        except CronError as error:
            problems.append(field_problem("cron", error.code, error.message))
    try:
        zone = load_timezone(values.timezone)
    except CronError as error:
        problems.append(field_problem("timezone", error.code, error.message))
    if problems or zone is None:
        raise invalid_schedule(problems)
    return ValidatedTiming(cron=schedule, zone=zone)


def merge_update(current: ScheduleValues, body: ScheduleUpdate) -> ScheduleValues:
    given = body.model_fields_set
    tier = body.tier if "tier" in given and body.tier is not None else current.tier
    if "cron" in given:
        cron = normalised_cron(body.cron)
    elif tier is ScheduleTier.commit:
        cron = None
    else:
        cron = current.cron
    return ScheduleValues(
        tier=tier,
        cron=cron,
        timezone=body.timezone if "timezone" in given and body.timezone else current.timezone,
        enabled=body.enabled
        if "enabled" in given and body.enabled is not None
        else current.enabled,
        budget=body.budget if "budget" in given else current.budget,
        notify=normalised_notify(body.notify)
        if "notify" in given and body.notify is not None
        else current.notify,
    )


def apply_values(row: ScheduleRow, values: ScheduleValues) -> None:
    row.tier = values.tier
    row.cron = values.cron
    row.timezone = values.timezone
    row.enabled = values.enabled
    row.budget = None if values.budget is None else values.budget.model_dump(mode="json")
    row.notify = values.notify.model_dump(mode="json")


def spec_for(schedule_id: UUID, values: ScheduleValues, timing: ValidatedTiming) -> ScheduleSpec:
    return ScheduleSpec(
        schedule_id=schedule_id,
        temporal_schedule_id=temporal_schedule_id(schedule_id),
        cron=None if timing.cron is None else timing.cron.canonical,
        timezone=values.timezone,
        paused=not values.enabled,
    )


def gateway_spec(row: ScheduleRow) -> ScheduleSpec:
    values = ScheduleValues.from_row(row)
    return spec_for(row.id, values, validate_timing(values))
