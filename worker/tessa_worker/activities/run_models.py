from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import BudgetState, RunCounters, Verdict
from tessa_api.schemas.enums import ModelRole, RunScenarioStatus, SeedAction, SkipReason
from tessa_api.schemas.runs import ClockSnapshot, ModelSnapshot
from tessa_api.schemas.temporal import GenerateSmokeScenarioResult, SeedTargetResult

SEED_UNVERIFIED_REASON = "seed_unverified"


class PublishRunProgressInput(BaseModel):
    run_id: UUID
    sequence: int = Field(ge=1, description="1-based publication number; keeps event keys unique")
    budget: BudgetState = Field(description="ledger of the workflow at the time of publication")


class PublishRunProgressResult(BaseModel):
    counters: RunCounters
    spent_usd: float = Field(
        default=0.0, ge=0, description="spend the model-call recorder charged to the run so far"
    )
    blocked_calls: int = Field(
        default=0,
        ge=0,
        description="model calls the budget refused because it could not cover them",
    )


class BeginScenarioAttemptInput(BaseModel):
    run_scenario_id: UUID
    attempt: int = Field(ge=0)


class RecordScenarioAttemptInput(BaseModel):
    run_scenario_id: UUID
    attempt: int = Field(ge=0)
    status: RunScenarioStatus
    verdict: Verdict | None


class FinishRunScenarioInput(BaseModel):
    run_scenario_id: UUID
    status: RunScenarioStatus
    verdict: Verdict | None


class SkipRunScenariosInput(BaseModel):
    run_id: UUID
    reason: SkipReason


class SkipRunScenariosResult(BaseModel):
    run_scenario_ids: list[UUID]


class SkipUngradedStepsInput(BaseModel):
    run_id: UUID
    reason: SkipReason


class SkipUngradedStepsResult(BaseModel):
    step_ids: list[UUID]


class AssertSeedInput(BaseModel):
    run_id: UUID
    reset_seed: bool = Field(
        default=False, description="true when the run asked to reset the seed before the check"
    )


class SeedAssertionPlan(BaseModel):
    target_id: UUID | None = None
    seed_id: UUID | None = Field(
        default=None, description="seed the SeedTarget child works on; null when nothing runs"
    )
    action: SeedAction | None = None
    unverified_reason: str | None = Field(
        default=None, description="why the run proceeds without a verified seed"
    )
    failure_reason: str | None = Field(
        default=None, description="why a requested reset or the check cannot run at all"
    )


class SettleSeedAssertionInput(BaseModel):
    run_id: UUID
    action: SeedAction
    result: SeedTargetResult | None = Field(
        default=None, description="what the SeedTarget child returned; null when it failed"
    )
    failure_code: str | None = Field(
        default=None, description="error type the SeedTarget child failed with"
    )
    failure_message: str | None = None


class FreezeRunConfigInput(BaseModel):
    run_id: UUID


class FreezeRunConfigResult(BaseModel):
    clock: ClockSnapshot
    models: dict[ModelRole, ModelSnapshot]
    probe_bank_version: str


class GenerateSmokeScenarioOutcome(GenerateSmokeScenarioResult):
    created: int = Field(default=0, ge=0, description="scenarios the call created")
    reused: int = Field(default=0, ge=0, description="scenarios the call found already stored")
