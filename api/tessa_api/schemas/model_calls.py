from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import Effort, ModelCallRole, ModelCallStatus
from tessa_api.schemas.grading import ModelUsage

EMBED_MAX_TEXTS_PER_CALL = 8
EMBED_MAX_TEXT_CHARS = 2000
EMBED_MAX_USD_PER_CALL = 0.001


class EmbedCallSpec(BaseModel):
    model: str = Field(
        min_length=1, description="embedding model id, or stub when TESSA_STUB_MODELS is on"
    )
    dimensions: int = Field(gt=0, description="vector size; equals TESSA_EMBEDDING_DIMENSIONS")
    max_usd: float = Field(ge=0, description="budget of one call; checked against the run ledger")
    start_to_close_timeout_seconds: int = Field(ge=1)
    max_attempts: int = Field(ge=1)


class ModelCallReservation(BaseModel):
    run_id: UUID | None = Field(description="run whose ledger is charged; null outside a run")
    role: ModelCallRole
    activity: str = Field(min_length=1)
    max_usd: float = Field(ge=0, description="the most the call may cost, reserved before it")
    model: str | None = Field(
        default=None, description="model id of the call, stored on a budget_blocked row"
    )
    step_id: UUID | None = Field(
        default=None, description="step the call belongs to, stored on a budget_blocked row"
    )
    effort: Effort | None = Field(
        default=None, description="reasoning effort of the call, stored on a budget_blocked row"
    )


class ModelCallRecord(ModelUsage):
    id: UUID = Field(
        description="row id; a deterministic id makes a retried activity record the call once"
    )
    run_id: UUID | None
    step_id: UUID | None
    role: ModelCallRole
    activity: str = Field(min_length=1, description="name of the activity that made the call")
    model: str = Field(min_length=1, description="model id, or stub for a stubbed call")
    effort: Effort | None
    latency_ms: int = Field(ge=0)
    status: ModelCallStatus


class ModelCall(ModelCallRecord):
    created_at: Timestamp
