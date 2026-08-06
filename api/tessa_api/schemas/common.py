from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, PlainSerializer

from tessa_api.schemas.enums import (
    RunKind,
    RunStatus,
    SkipReason,
    VerdictStatus,
    VerdictTier,
)


def to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("timestamp must carry a UTC offset")
    return value.astimezone(UTC)


def format_timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


Timestamp = Annotated[
    datetime,
    AfterValidator(to_utc),
    PlainSerializer(format_timestamp, return_type=str, when_used="json"),
]

Probability = Annotated[float, Field(ge=0, le=1)]

EMBEDDING_DIMENSIONS = 1536


class ErrorDetail(BaseModel):
    loc: list[str | int]
    code: str
    message: str


class ErrorBody(BaseModel):
    code: str
    message: str
    request_id: str
    details: list[ErrorDetail]


class ErrorResponse(BaseModel):
    error: ErrorBody


class RunHandle(BaseModel):
    run_id: UUID
    workflow_id: str
    kind: RunKind
    status: RunStatus
    created_at: Timestamp


class RunCounters(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    scenarios_total: int = Field(ge=0)
    scenarios_done: int = Field(ge=0)
    pass_: int = Field(ge=0, alias="pass")
    fail: int = Field(ge=0)
    flaky: int = Field(ge=0)
    uncertain: int = Field(ge=0)
    skipped: int = Field(ge=0)
    steps_recorded: int = Field(ge=0)


class Verdict(BaseModel):
    status: VerdictStatus
    tier: VerdictTier
    confidence: float | None = Field(
        ge=0, le=1, description="confidence from 0 to 1; null when the tier gives none"
    )
    reason_code: str | None = Field(description="stable machine readable reason")
    reason: str | None = Field(description="short human readable reason")
    skip_reason: SkipReason | None = Field(description="set exactly when status is skipped")


class Budget(BaseModel):
    max_usd: float = Field(ge=0, description="spend ceiling in USD")
    max_minutes: int = Field(ge=1, description="wall clock ceiling in minutes")


class BudgetState(BaseModel):
    max_usd: float = Field(ge=0, description="spend ceiling in USD")
    spent_usd: float = Field(ge=0, description="spent so far in USD")
    max_minutes: int = Field(ge=1, description="wall clock ceiling in minutes")
    elapsed_ms: int = Field(ge=0, description="wall clock used so far in milliseconds")


class Viewport(BaseModel):
    width: int = Field(gt=0, description="viewport width in pixels")
    height: int = Field(gt=0, description="viewport height in pixels")


class AttemptTally(BaseModel):
    passed: int = Field(ge=0, description="attempts that passed")
    failed: int = Field(ge=0, description="attempts that failed")
    total: int = Field(ge=0, description="attempts planned for the scenario")
