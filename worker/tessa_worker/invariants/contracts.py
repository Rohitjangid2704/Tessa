from collections.abc import Sequence
from typing import Protocol, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from tessa_api.schemas.common import Probability
from tessa_api.schemas.enums import (
    AdapterKind,
    AppKind,
    InvariantCheck,
    InvariantPack,
    SkipReason,
    VerdictStatus,
    VerdictTier,
)
from tessa_api.schemas.grading import ProbeBatchResult
from tessa_api.schemas.oracles import DbCheck, GoldPoint
from tessa_api.schemas.steps import StepRequestUnion, StepResponseUnion, StepTool, Tier0Result
from tessa_api.schemas.temporal import RunLayaProbesInput
from tessa_worker.activities.grading_models import ProbePolarity


class InvariantStep(BaseModel):
    model_config = ConfigDict(frozen=True)

    step_id: UUID
    index: int = Field(ge=0)
    attempt: int = Field(ge=0)
    adapter: AdapterKind
    label: str
    ok: bool | None
    request: StepRequestUnion | None = Field(description="null when the payload was purged")
    response: StepResponseUnion | None = Field(description="null when the payload was purged")
    ask: str | None
    answer: str | None
    tools: list[StepTool]
    cards: list[dict[str, JsonValue]]
    latency_ms: int = Field(ge=0)
    tier0: Tier0Result
    gold_points: list[GoldPoint]
    db_checks: list[DbCheck]
    oracle_row_counts: dict[UUID, int] = Field(
        default_factory=dict,
        description="rows each oracle result behind a gold point returned, by oracle result id",
    )


class InvariantContext(BaseModel):
    model_config = ConfigDict(frozen=True)

    run_id: UUID
    run_scenario_id: UUID
    scenario_id: UUID
    attempt: int | None = Field(
        ge=0, description="attempt under evaluation; null for a run-level evaluation"
    )
    feature_id: str | None
    family: str
    role: str
    interface_id: str
    app_kind: AppKind
    read_only: bool = Field(description="true on production targets")
    steps: list[InvariantStep] = Field(description="steps of the attempt in order")
    params: dict[str, JsonValue] = Field(
        description="bundle declared parameters of this invariant, such as a latency limit or "
        "the field patterns of pii_by_role"
    )
    latency_default_ms: int = Field(
        gt=0, description="TESSA_INVARIANT_LATENCY_MS, used when params carry no limit"
    )
    internal_id_patterns: tuple[str, ...] = Field(
        description="regular expressions that match an internal identifier"
    )
    probe_polarity: dict[str, ProbePolarity] = Field(
        default_factory=dict,
        description="compliant answer and allowed answers of every probe, by probe id",
    )


class InvariantOutcome(BaseModel):
    model_config = ConfigDict(frozen=True)

    invariant_id: str
    pack: InvariantPack
    status: VerdictStatus
    tier: VerdictTier
    confidence: Probability | None
    message: str = Field(description="short redacted explanation, never a secret or a long text")
    skip_reason: SkipReason | None = Field(description="set exactly when status is skipped")
    step_id: UUID | None = Field(description="step the outcome concerns; null for a whole attempt")
    signal: str | None = Field(
        description="normalised failing signal that the finding fingerprint is built from"
    )

    @model_validator(mode="after")
    def skip_reason_matches_status(self) -> Self:
        if (self.status is VerdictStatus.skipped) != (self.skip_reason is not None):
            raise ValueError("skip_reason is set exactly when status is skipped")
        return self


class ProbeRunner(Protocol):
    async def run_laya_probes(self, request: RunLayaProbesInput) -> ProbeBatchResult: ...


class InvariantEvaluator(Protocol):
    invariant_id: str
    pack: InvariantPack
    check: InvariantCheck

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]: ...
