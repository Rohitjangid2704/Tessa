from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import LabelReason, VerdictTier
from tessa_api.schemas.grading import ModelCallSpec
from tessa_api.schemas.steps import Tier0Result
from tessa_api.services.grading_rules import MachineGrading

LOAD_STEP_GRADING = "load_step_grading"
RECORD_STEP_GRADE = "record_step_grade"
RESOLVE_GRADE_POLICY = "resolve_grade_policy"
LIST_ATTEMPT_STEPS = "list_attempt_steps"


class ListAttemptStepsInput(BaseModel):
    run_scenario_id: UUID
    attempt: int = Field(ge=0)


class DecidedStep(BaseModel):
    step_id: UUID
    grading: MachineGrading


class ListAttemptStepsResult(BaseModel):
    step_ids: list[UUID] = Field(description="steps recorded for the attempt, in step order")
    decided: list[DecidedStep] = Field(
        default_factory=list,
        description="steps a drive hook already graded (database checks): they skip GradeStep",
    )


class LoadStepGradingInput(BaseModel):
    step_id: UUID
    run_id: UUID


class ProbePolarity(BaseModel):
    compliant_answer: str = Field(description="the answer that means the step satisfies the probe")
    allowed_answers: list[str] = Field(description="every answer the probe may legitimately give")


class StepGradingContext(BaseModel):
    run_scenario_id: UUID
    step_completed: bool = Field(description="false when the adapter did not complete the step")
    tier0: Tier0Result | None = Field(
        description="stored Tier 0 result; null when it is missing or unreadable and must be "
        "recomputed"
    )
    probe_polarity: dict[str, ProbePolarity] = Field(
        description="compliant and allowed answers of every probe known for the run, by probe id"
    )
    judge_spec: ModelCallSpec
    tiebreak_spec: ModelCallSpec
    budget_remaining_usd: float = Field(
        ge=0, description="run budget minus the spend the run ledger has published so far"
    )


class RecordStepGradeInput(BaseModel):
    step_id: UUID
    run_id: UUID
    verdict: Verdict
    escalated_to: VerdictTier | None
    review_reasons: list[LabelReason]


class RecordStepGradeResult(BaseModel):
    verdict: Verdict = Field(description="effective verdict: a human label wins over the machine")
    escalated_to: VerdictTier | None
