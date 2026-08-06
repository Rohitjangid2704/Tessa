from enum import StrEnum
from typing import Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from tessa_api.schemas.common import Budget, RunCounters, Timestamp
from tessa_api.schemas.enums import RunStatus, ScheduleTier
from tessa_api.schemas.goals import ui_hints

SCHEDULE_SCHEMA_VERSION = 1
SCHEDULE_CRON_MAX_LENGTH = 120
SCHEDULE_TIMEZONE_MAX_LENGTH = 64
DEFAULT_SCHEDULE_TIMEZONE = "UTC"
SCHEDULE_REQUIRED_UPDATE_FIELDS = ("tier", "timezone", "enabled", "notify")


class ScheduleRunOutcome(StrEnum):
    running = "running"
    passed = "passed"
    failed = "failed"
    uncertain = "uncertain"
    errored = "errored"
    canceled = "canceled"


class ScheduleNotify(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        title="ScheduleNotify",
        json_schema_extra={"description": "Where a finished scheduled run is announced."},
    )

    slack: bool = Field(
        default=False,
        title="Slack",
        description="Post the summary to the Slack webhook set in Settings.",
        json_schema_extra=ui_hints("Slack", "Notify", 1, "toggle"),
    )


class ScheduleFields(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        title="Schedule",
        json_schema_extra={
            "description": "A recurring run of one saved plan: when it fires, how much it may "
            "spend and who hears about it."
        },
    )

    plan_id: UUID = Field(
        title="Plan",
        description="The saved plan this schedule runs.",
        json_schema_extra=ui_hints("Plan", "What", 1, "text"),
    )
    tier: ScheduleTier = Field(
        default=ScheduleTier.nightly,
        title="Tier",
        description="commit runs from CI through run-now with depth smoke and no judge; "
        "nightly and weekly run on a cron.",
        json_schema_extra=ui_hints("Tier", "When", 2, "select"),
    )
    cron: str | None = Field(
        default=None,
        max_length=SCHEDULE_CRON_MAX_LENGTH,
        title="Cron",
        description="Five-field cron (minute hour day-of-month month day-of-week) read in the "
        "schedule time zone: numbers, ranges, lists, steps and month and weekday names; day of "
        "month and day of week cannot both be restricted. Required for nightly and weekly; the "
        "commit tier takes none.",
        examples=["0 2 * * *"],
        json_schema_extra=ui_hints("Cron", "When", 3, "text"),
    )
    timezone: str = Field(
        default=DEFAULT_SCHEDULE_TIMEZONE,
        min_length=1,
        max_length=SCHEDULE_TIMEZONE_MAX_LENGTH,
        title="Time zone",
        description="IANA time zone name such as Europe/London. The cron is read in this zone.",
        examples=["Europe/London"],
        json_schema_extra=ui_hints("Time zone", "When", 4, "text"),
    )
    enabled: bool = Field(
        default=True,
        title="Enabled",
        description="A disabled schedule keeps its settings and does not fire.",
        json_schema_extra=ui_hints("Enabled", "When", 5, "toggle"),
    )
    budget: Budget | None = Field(
        default=None,
        title="Budget",
        description="Optional ceilings for each run; the plan budget applies when empty.",
        json_schema_extra=ui_hints("Budget", "Limits", 6, "json"),
    )
    notify: ScheduleNotify = Field(
        default_factory=ScheduleNotify,
        title="Notify",
        description="Where a finished run is announced.",
    )


class ScheduleCreate(ScheduleFields):
    model_config = ConfigDict(extra="forbid", title="ScheduleCreate")


class ScheduleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tier: ScheduleTier | None = None
    cron: str | None = Field(
        default=None,
        max_length=SCHEDULE_CRON_MAX_LENGTH,
        description="an explicit null clears the cron",
    )
    timezone: str | None = Field(
        default=None, min_length=1, max_length=SCHEDULE_TIMEZONE_MAX_LENGTH
    )
    enabled: bool | None = None
    budget: Budget | None = Field(
        default=None, description="an explicit null removes the schedule budget"
    )
    notify: ScheduleNotify | None = None

    @model_validator(mode="after")
    def required_fields_are_not_null(self) -> Self:
        nulled = [
            name
            for name in SCHEDULE_REQUIRED_UPDATE_FIELDS
            if name in self.model_fields_set and getattr(self, name) is None
        ]
        if nulled:
            raise ValueError(f"{', '.join(nulled)} cannot be null")
        return self


class ScheduleLastRun(BaseModel):
    run_id: UUID
    status: RunStatus
    outcome: ScheduleRunOutcome = Field(
        description="failed when a scenario failed or was flaky, uncertain when nothing failed "
        "but a result is uncertain, the run stopped on its budget or nothing passed; uncertain "
        "is never reported as a pass or as a failure"
    )
    started_at: Timestamp | None
    finished_at: Timestamp | None
    counters: RunCounters = Field(description="pass, fail, flaky, uncertain and skipped stay apart")


class Schedule(BaseModel):
    id: UUID
    plan_id: UUID
    tier: ScheduleTier
    cron: str | None
    timezone: str
    enabled: bool
    budget: Budget | None
    temporal_schedule_id: str
    last_run_id: UUID | None
    next_run_at: Timestamp | None = Field(
        description="next firing of the cron in the schedule time zone, taken from the Temporal "
        "schedule on the detail route when it answers; null when disabled or without a cron"
    )
    notify: ScheduleNotify
    last_run: ScheduleLastRun | None = Field(
        default=None,
        description="summary of the run last_run_id points at; null before the first run",
    )


class SchedulePage(BaseModel):
    items: list[Schedule]
    next_cursor: str | None
    total: int | None


class ScheduleSpec(BaseModel):
    schedule_id: UUID = Field(description="schedules row the Temporal Schedule belongs to")
    temporal_schedule_id: str
    cron: str | None = Field(description="null for the commit tier, which fires only by run-now")
    timezone: str
    paused: bool = Field(description="true when the schedule is disabled")


class ScheduleDescription(BaseModel):
    temporal_schedule_id: str
    cron: str | None
    timezone: str | None
    paused: bool
    next_run_at: Timestamp | None
    last_run_at: Timestamp | None


class ScheduledRunStart(BaseModel):
    schedule_id: UUID
    run_id: UUID = Field(
        description="run id the ScheduledRun workflow chose, so a retried call creates one run"
    )


class ScheduledRunStarted(BaseModel):
    run_id: UUID
    workflow_id: str = Field(description="id the ExecuteRun child of the run must use")
    status: RunStatus
    created: bool = Field(description="false when the run row already existed")
