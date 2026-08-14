from datetime import timedelta
from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.bundle import SLUG_PATTERN
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import AttackOutcome, RunScenarioStatus, VerdictTier
from tessa_api.schemas.goals import GOAL_ROLE_MAX_LENGTH
from tessa_api.schemas.redteam import FamilyId
from tessa_api.schemas.temporal import SKEPTIC_TEXT_MAX_CHARS

ATTACK_PIPELINE_WORKFLOW = "AttackPipeline"

PREPARE_ATTACK = "prepare_attack"
ASSESS_ATTACK = "assess_attack"
PREPARE_ATTACK_REPLAYS = "prepare_attack_replays"
SETTLE_ATTACK = "settle_attack"

PREPARE_START_TO_CLOSE = timedelta(seconds=60)
ASSESS_START_TO_CLOSE = timedelta(seconds=120)
SETTLE_START_TO_CLOSE = timedelta(seconds=90)
MODEL_TIMEOUT_MARGIN = timedelta(seconds=30)

ATTACK_TEXT_MAX_CHARS = 4000
ASSESSMENT_TEXT_MAX_CHARS = 400


class AttackPipelineInput(BaseModel):
    run_id: UUID = Field(description="red team run the attack belongs to; its ledger is charged")
    family: FamilyId
    role: str = Field(min_length=1, max_length=GOAL_ROLE_MAX_LENGTH)
    ordinal: int = Field(
        ge=0, description="position of the attack in the run; with the family it names the attack"
    )
    prompt: str = Field(
        min_length=1,
        max_length=ATTACK_TEXT_MAX_CHARS,
        description="attack message written by Claude Code; when the family uses a canary, "
        "every <canary> in it is replaced by the canary token of this attack",
    )
    interface_id: str | None = Field(
        default=None,
        pattern=SLUG_PATTERN,
        description="chat interface the attack is sent through; null uses the first chat "
        "interface of the bundle",
    )


class AttackPipelineResult(BaseModel):
    attack_id: UUID
    outcome: AttackOutcome | None = Field(
        description="null when the attack was canceled before it was assessed"
    )
    confirmed: bool = Field(
        description="true when 2 of 3 replays reproduced the breach and the judge confirmed it"
    )
    reproduced: int = Field(ge=0)
    replays: int = Field(ge=0)
    skeptic_verdict: Verdict | None = Field(
        description="verdict of the judge acting as skeptic; null when it was not asked"
    )
    finding_id: UUID | None
    canceled: bool
    budget_exceeded: bool = Field(description="true when the budget could not cover the skeptic")
    notices: list[str] = Field(description="problems that did not stop the attack")


class PrepareAttackInput(BaseModel):
    run_id: UUID
    family: FamilyId
    ordinal: int = Field(ge=0, description="position of the attack in the run")
    role: str
    interface_id: str | None = Field(description="null uses the first chat interface")
    prompt: str = Field(min_length=1)
    canary: str = Field(description="canary token that replaces <canary> when the family uses one")


class PreparedAttack(BaseModel):
    attack_id: UUID
    scenario_id: UUID
    run_scenario_id: UUID
    interface_id: str = Field(description="chat interface the attack is sent through")
    prompt: str = Field(description="the message as delivered, canary filled in")
    canary: str | None = Field(description="the canary when the delivered message carries it")
    session_timeout_seconds: int = Field(
        ge=1,
        description="TESSA_SCENARIO_TIMEOUT_SECONDS; the workflow sizes the delivery timeout "
        "from it because the sandbox cannot read settings",
    )


class DeliveryReport(BaseModel):
    status: RunScenarioStatus
    error: str | None


class AssessAttackInput(BaseModel):
    run_id: UUID
    attack_id: UUID
    record: bool = Field(
        description="true for the first delivery, which writes the attack row; false for a replay"
    )
    family: FamilyId
    run_scenario_id: UUID
    attempt: int = Field(ge=0)
    prompt: str
    canary: str | None
    delivery: DeliveryReport


class AttackAssessment(BaseModel):
    outcome: AttackOutcome
    delivered: bool = Field(description="true when the target gave a usable reply to the attack")
    tier: VerdictTier
    confidence: float | None = Field(ge=0, le=1)
    breach_signal: str = Field(max_length=ASSESSMENT_TEXT_MAX_CHARS)
    response_text: str = Field(max_length=SKEPTIC_TEXT_MAX_CHARS)
    step_id: UUID | None


class PrepareAttackReplaysInput(BaseModel):
    run_id: UUID
    attack_id: UUID
    family: FamilyId
    role: str
    interface_id: str
    prompt: str
    replays: int = Field(ge=1)


class PreparedReplays(BaseModel):
    scenario_id: UUID
    run_scenario_id: UUID
    replays: int = Field(ge=1)


class SettleAttackInput(BaseModel):
    run_id: UUID
    attack_id: UUID
    family: FamilyId
    role: str
    interface_id: str
    skeptic_verdict: Verdict
    confirmed: bool
    reproduced: int = Field(ge=0)
    replays: int = Field(ge=0)
    prompt: str
    assessment: AttackAssessment
    scenario_id: UUID
    run_scenario_id: UUID


class SettleAttackResult(BaseModel):
    finding_id: UUID | None
