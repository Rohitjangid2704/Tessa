from typing import Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from tessa_api.schemas.common import Probability, Verdict
from tessa_api.schemas.enums import Effort, JudgeFamily, JudgeOrder, ModelRole
from tessa_api.schemas.probes import ProbeResult


class ModelUsage(BaseModel):
    cost_usd: float = Field(ge=0, description="money charged for the call in USD")
    input_tokens: int = Field(ge=0, description="input tokens the provider reported")
    output_tokens: int = Field(ge=0, description="output tokens the provider reported")


class ModelCallSpec(BaseModel):
    role: ModelRole
    model: str = Field(
        min_length=1, description="model id, or stub when TESSA_STUB_MODELS is on"
    )
    effort: Effort
    max_usd: float = Field(ge=0, description="budget of one call; checked against the run ledger")
    max_input_tokens: int = Field(ge=1)
    max_output_tokens: int = Field(ge=1)
    start_to_close_timeout_seconds: int = Field(ge=1)
    max_attempts: int = Field(ge=1)


class GradePolicy(BaseModel):
    probe_confidence: Probability = Field(description="probe confidence needed to decide")
    judge_escalate_below: Probability = Field(
        description="decided probes below this confidence still go to the judge"
    )
    tiebreak_enabled: bool = Field(
        description="true when the second model family may break a position swap disagreement"
    )
    judge_enabled: bool = Field(
        default=True,
        description="false grades with code and Laya only: a step that needs the judge ends "
        "uncertain instead of calling a model",
    )

    def without_judge(self) -> Self:
        return self.model_copy(update={"judge_enabled": False, "tiebreak_enabled": False})


class EvidenceBlockModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvidenceGoldPoint(EvidenceBlockModel):
    key: str
    value: JsonValue
    rendered: str


class EvidenceInvariant(EvidenceBlockModel):
    id: str
    rule: str


class EvidenceBlock(EvidenceBlockModel):
    ask: str | None = Field(description="what was asked; null for steps without a question")
    answer: str | None = Field(description="the answer under test, fenced as untrusted data")
    gold_points: list[EvidenceGoldPoint]
    must_not_claim: list[str]
    unsupported_claim_candidates: list[str] = Field(
        description="claims in the answer that no gold point supports"
    )
    invariants: list[EvidenceInvariant]
    rubric: str = Field(description="rubric text the judge applies")


class JudgeEvidence(BaseModel):
    gold_points: list[EvidenceGoldPoint] = Field(description="gold points the judge relied on")
    must_not_claim: list[str] = Field(description="forbidden claims the judge found in the answer")
    unsupported_claims: list[str] = Field(description="claims the judge found unsupported")


class JudgePairwise(BaseModel):
    swapped_agrees: bool = Field(description="true when both presentation orders gave one verdict")


class JudgeResult(BaseModel):
    id: UUID
    family: JudgeFamily
    model: str
    effort: Effort
    rubric_version: str
    verdict: Verdict
    pairwise: JudgePairwise | None = Field(
        description="null when no reference existed and a single pass was used"
    )
    evidence: JudgeEvidence
    cost_usd: float = Field(ge=0)


class JudgeStepInput(BaseModel):
    step_id: UUID
    evidence: EvidenceBlock
    order: JudgeOrder = Field(description="presentation order of the answer and the reference")
    spec: ModelCallSpec
    paired_with: UUID | None = Field(
        default=None,
        description="judge result of the first order when this call is the swapped one",
    )


class JudgeStepOutput(ModelUsage):
    verdict: Verdict
    rationale: str = Field(description="short reason the judge gave")
    evidence: JudgeEvidence
    judge_result_id: UUID = Field(description="judge_results row this call wrote or completed")
    swapped_agrees: bool | None = Field(
        default=None, description="set by the swapped call: whether both orders agreed"
    )


class ProbeBatchResult(BaseModel):
    results: list[ProbeResult]
