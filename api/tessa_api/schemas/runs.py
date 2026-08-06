from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from tessa_api.schemas.common import (
    BudgetState,
    RunCounters,
    Timestamp,
    Verdict,
    Viewport,
)
from tessa_api.schemas.enums import (
    BrowserSessionStatus,
    Effort,
    ModelRole,
    PromptTemplateName,
    RunKind,
    RunScenarioStatus,
    RunStatus,
    RunTrigger,
    ScheduleTier,
    SkipReason,
)
from tessa_api.schemas.plans import PlanCreate
from tessa_api.schemas.steps import StepSummary

SUBSET_MAX_SCENARIOS = 50


class ClockSnapshot(BaseModel):
    mode: Literal["pinned", "real"] = Field(description="pinned through a target hook or real")
    at: Timestamp = Field(description="the moment every today parameter of the run resolves to")


class ModelSnapshot(BaseModel):
    model: str = Field(description="model name used for the role")
    effort: Effort = Field(description="reasoning effort used for the role")


class RunConfigSnapshot(BaseModel):
    bundle_id: UUID | None = Field(
        description="bundle the run runs against; null only for an import run, which has no "
        "bundle until it has created one"
    )
    bundle_version: int | None = Field(ge=1, description="version of that bundle; null with it")
    bundle_hash: str | None = Field(description="content hash of that bundle; null with it")
    seed_hash: str | None = Field(description="null until Stage 3")
    clock: ClockSnapshot | None = Field(description="null until Stage 3")
    models: dict[ModelRole, ModelSnapshot] | None = Field(description="null until Stage 4")
    probe_bank_version: str | None = Field(description="null until Stage 4")
    prompt_template_versions: dict[PromptTemplateName, int] = Field(
        description="prompt template versions the run depends on"
    )
    scenario_versions: dict[UUID, int] = Field(
        description="version of every scenario of the run, pinned at the end of planning"
    )
    base_url_override: str | None = Field(
        default=None,
        description="address of the mutant that replaced the origin of the target URL variables; "
        "null outside mutation runs",
    )
    schedule_id: UUID | None = Field(
        default=None,
        description="schedule that started the run, through its cron or run-now; null for runs "
        "nobody scheduled",
    )
    schedule_tier: ScheduleTier | None = Field(
        default=None,
        description="tier of that schedule; commit runs the smoke scenarios only, grades with "
        "code and Laya and stops after TESSA_COMMIT_TIER_MAX_MINUTES",
    )
    scenario_ids: list[UUID] | None = Field(
        default=None,
        description="scenarios a subset run was asked to run and nothing else; null for a "
        "run of a plan. A subset run skips the synthetic invariant scenarios and the API fuzz "
        "family",
    )
    bundle_commit: str | None = Field(
        default=None,
        description="commit the bundle was produced from, when its manifest names one",
    )


class RunCreate(BaseModel):
    plan_id: UUID | None = Field(default=None, description="saved plan to run")
    plan: PlanCreate | None = Field(
        default=None, description="inline plan; the server saves it with saved=false"
    )
    scenario_ids: list[UUID] | None = Field(
        default=None,
        min_length=1,
        max_length=SUBSET_MAX_SCENARIOS,
        description="run exactly these accepted scenarios of target_id, at smoke depth, once "
        "each; exclusive with plan_id and plan",
    )
    target_id: UUID | None = Field(
        default=None, description="target of the scenarios; required with scenario_ids"
    )
    max_concurrency: int | None = Field(
        default=None, ge=1, description="scenarios run at once; capped by the server"
    )
    reset_seed: bool = Field(
        default=False,
        description="true resets the seed before the run asserts its hash; Stage 3",
    )

    @model_validator(mode="after")
    def names_exactly_one_selection(self) -> Self:
        if self.scenario_ids is not None:
            if self.plan_id is not None or self.plan is not None:
                raise ValueError("scenario_ids cannot be combined with plan_id or plan")
            if self.target_id is None:
                raise ValueError("target_id is required with scenario_ids")
            self.scenario_ids = list(dict.fromkeys(self.scenario_ids))
            return self
        if self.target_id is not None:
            raise ValueError("target_id is only used together with scenario_ids")
        if (self.plan_id is None) == (self.plan is None):
            raise ValueError("send exactly one of plan_id, plan and scenario_ids")
        return self


class RunSummary(BaseModel):
    id: UUID
    kind: RunKind
    target_id: UUID | None
    plan_id: UUID | None
    status: RunStatus
    counters: RunCounters
    budget: BudgetState
    read_only: bool
    started_at: Timestamp | None
    finished_at: Timestamp | None
    created_at: Timestamp


class Run(RunSummary):
    trigger: RunTrigger
    bundle_id: UUID | None = Field(
        description="bundle the run runs against; for a finished import run the bundle it "
        "created, null until then"
    )
    config_snapshot: RunConfigSnapshot
    event_head_seq: int = Field(ge=0, description="highest persisted event seq of the run")
    workflow_id: str
    temporal_ui_url: str | None = Field(description="link to the workflow in the Temporal UI")
    stop_requested_at: Timestamp | None = Field(
        description="when POST /runs/{run_id}/stop was requested; null until then"
    )
    created_by: UUID


class RunSummaryPage(BaseModel):
    items: list[RunSummary]
    next_cursor: str | None
    total: int | None


class RunScenarioSummary(BaseModel):
    id: UUID
    scenario_id: UUID
    title: str
    family: str
    role: str
    interface_id: str
    status: RunScenarioStatus
    verdict: Verdict | None
    attempts_total: int = Field(ge=1)
    attempts_done: int = Field(ge=0)
    duration_ms: int | None


class RunScenarioAttempt(BaseModel):
    attempt: int = Field(ge=0, description="attempt number from 0")
    status: RunScenarioStatus
    verdict: Verdict | None


class RunScenario(RunScenarioSummary):
    attempts: list[RunScenarioAttempt]
    steps: list[StepSummary]
    scenario_yaml: str = Field(description="the scenario version this run executed")
    skip_reason: SkipReason | None = Field(description="set when the status is skipped")


class RunScenarioPage(BaseModel):
    items: list[RunScenarioSummary]
    next_cursor: str | None
    total: int | None


class BrowserSession(BaseModel):
    id: UUID
    run_scenario_id: UUID
    scenario_title: str
    attempt: int = Field(ge=0)
    status: BrowserSessionStatus
    viewport: Viewport
    last_url: str | None
    has_recording: bool
    has_trace: bool
    started_at: Timestamp
    ended_at: Timestamp | None


class BrowserSessionList(BaseModel):
    items: list[BrowserSession]
