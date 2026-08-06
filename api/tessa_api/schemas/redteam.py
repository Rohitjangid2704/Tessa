from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Budget, Timestamp, Verdict
from tessa_api.schemas.enums import AttackOutcome
from tessa_api.schemas.goals import GOAL_ROLE_MAX_LENGTH

REDTEAM_MAX_ROUNDS_LIMIT = 50
REDTEAM_MAX_FAMILIES = 32
FAMILY_ID_MAX_LENGTH = 64
ATTACK_EXCERPT_MAX_CHARS = 500

FamilyId = Annotated[str, Field(min_length=1, max_length=FAMILY_ID_MAX_LENGTH)]


class RedTeamFamilyInfo(BaseModel):
    id: str = Field(description="family slug sent as an entry of RedTeamCreate.families")
    title: str
    description: str


class RedTeamFamilyList(BaseModel):
    items: list[RedTeamFamilyInfo]


class RedTeamCreate(BaseModel):
    target_id: UUID
    role: str = Field(
        min_length=1,
        max_length=GOAL_ROLE_MAX_LENGTH,
        description="app role the attacker talks to the target as",
    )
    families: list[FamilyId] = Field(
        min_length=1,
        max_length=REDTEAM_MAX_FAMILIES,
        description="family ids from GET /redteam/families",
    )
    max_rounds: int | None = Field(
        default=None,
        ge=1,
        le=REDTEAM_MAX_ROUNDS_LIMIT,
        description="round ceiling; absent uses TESSA_REDTEAM_MAX_ROUNDS",
    )
    budget: Budget


class RedTeamRound(BaseModel):
    id: UUID
    run_id: UUID
    index: int = Field(ge=1, description="round number from 1 in the order rounds started")
    family: str
    dry: bool = Field(description="true when the round confirmed no attack")
    attacks: int = Field(ge=0, description="attacks of the round, counted from attacks")
    candidates: int = Field(
        ge=0, description="attacks of the round that breached and went to verification"
    )
    started_at: Timestamp
    finished_at: Timestamp | None


class RedTeamRoundPage(BaseModel):
    items: list[RedTeamRound]
    next_cursor: str | None
    total: int | None


class Attack(BaseModel):
    id: UUID
    round_id: UUID
    family: str
    prompt_excerpt: str = Field(
        max_length=ATTACK_EXCERPT_MAX_CHARS, description="redacted start of the attack prompt"
    )
    response_excerpt: str = Field(
        max_length=ATTACK_EXCERPT_MAX_CHARS, description="redacted start of the target response"
    )
    outcome: AttackOutcome
    skeptic_verdict: Verdict | None = Field(
        description="verdict of the independent skeptic; null until a breach was verified"
    )
    finding_id: UUID | None = Field(description="set only after the breach was verified")


class AttackPage(BaseModel):
    items: list[Attack]
    next_cursor: str | None
    total: int | None
