from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Budget, Verdict
from tessa_api.schemas.enums import SimSpeaker, VerdictStatus
from tessa_api.schemas.goals import GOAL_ROLE_MAX_LENGTH

SIMULATION_MAX_K = 10
TRANSCRIPT_PREVIEW_MAX_CHARS = 200


class SimulationCreate(BaseModel):
    target_id: UUID
    persona_id: UUID
    goal_id: UUID
    role: str = Field(
        min_length=1,
        max_length=GOAL_ROLE_MAX_LENGTH,
        description="app role the simulated user signs in as",
    )
    k: int = Field(
        ge=1, le=SIMULATION_MAX_K, description="sessions to run; the overall verdict is pass^k"
    )
    budget: Budget


class SimTurn(BaseModel):
    turn: int = Field(ge=1, description="turn number from 1 in the order the turns were spoken")
    speaker: SimSpeaker
    text: str


class SimChecks(BaseModel):
    end_state: VerdictStatus = Field(description="end state of the target, checked by code")
    calls: VerdictStatus = Field(description="tool and API calls the session made, by code")
    invariants: VerdictStatus = Field(description="invariants evaluated on the session steps")
    goal: VerdictStatus = Field(
        description="success criteria of the goal: typed criteria by code, judge: by the judge"
    )
    dialogue: VerdictStatus = Field(
        description="quality of the dialogue by the judge; can lower a pass to uncertain, never "
        "to fail alone"
    )


class SimSession(BaseModel):
    id: UUID
    run_id: UUID
    persona_id: UUID
    goal_id: UUID
    attempt: int = Field(ge=0, description="attempt number from 0, one session per attempt")
    transcript: list[SimTurn]
    checks: SimChecks
    verdict: Verdict


class SimSessionPage(BaseModel):
    items: list[SimSession]
    next_cursor: str | None
    total: int | None
