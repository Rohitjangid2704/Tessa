from typing import Any, Final, Literal, Self
from urllib.parse import urlparse
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    field_validator,
    model_validator,
)

from tessa_api.schemas.artifacts import ArtifactRef, StoredArtifact
from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import FindingClass, FindingStatus, Severity
from tessa_api.schemas.explanations import Explanation
from tessa_api.schemas.runs import ClockSnapshot

FINDING_REPRO_SCHEMA_VERSION: Final = 1
REPRO_MAX_ORACLE_ROWS = 20
TICKET_URL_MAX_LENGTH = 2000
KNOWN_GAP_REASON_MAX_LENGTH = 2000
PROMOTED_SCENARIO_TITLE_MAX_LENGTH = 200
ALLOWED_TICKET_SCHEMES = frozenset({"http", "https"})


class FindingSummary(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    id: UUID
    target_id: UUID
    fingerprint: str = Field(description="stable hash that identifies the underlying problem")
    title: str
    class_: FindingClass = Field(alias="class")
    severity: Severity
    status: FindingStatus
    invariant_id: str | None
    scenario_id: UUID | None
    first_seen_at: Timestamp
    last_seen_at: Timestamp
    occurrence_count: int = Field(ge=1)
    ticket_url: str | None
    known_gap_reason: str | None
    promoted_scenario_id: UUID | None


class Finding(FindingSummary):
    first_seen_run_id: UUID
    last_seen_run_id: UUID
    latest_explanation: Explanation | None
    expected: JsonValue = Field(description="what the scenario expected; null when not known")
    actual: JsonValue = Field(description="what was observed; null when not known")


class FindingPage(BaseModel):
    items: list[FindingSummary]
    next_cursor: str | None
    total: int | None


class FindingUpdate(BaseModel):
    status: FindingStatus | None = Field(
        default=None, description="user moves follow the Finding status transitions table"
    )
    severity: Severity | None = None
    ticket_url: str | None = Field(
        default=None, max_length=TICKET_URL_MAX_LENGTH, description="an explicit null clears it"
    )
    known_gap_reason: str | None = Field(
        default=None,
        max_length=KNOWN_GAP_REASON_MAX_LENGTH,
        description="required when the finding moves to known_gap and none is stored",
    )

    @field_validator("ticket_url")
    @classmethod
    def require_web_url(cls, value: str | None) -> str | None:
        if value is None:
            return value
        parsed = urlparse(value)
        if parsed.scheme not in ALLOWED_TICKET_SCHEMES or not parsed.netloc:
            raise ValueError("ticket_url must be an http or https URL")
        return value

    @model_validator(mode="after")
    def validate_fields_set(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("send at least one field")
        for name in ("status", "severity"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class FindingOccurrence(BaseModel):
    id: UUID
    finding_id: UUID
    run_id: UUID
    run_scenario_id: UUID | None
    step_id: UUID | None
    attempt: int | None = Field(ge=0)
    seen_at: Timestamp
    evidence: dict[str, Any] = Field(
        description="short redacted facts; carries possible_duplicate_of when dedupe was uncertain"
    )


class FindingOccurrencePage(BaseModel):
    items: list[FindingOccurrence]
    next_cursor: str | None
    total: int | None


class PromoteFindingCreate(BaseModel):
    title: str | None = Field(
        default=None,
        min_length=1,
        max_length=PROMOTED_SCENARIO_TITLE_MAX_LENGTH,
        description="title of the promoted scenario; absent derives it from the finding",
    )


class ReproSeed(BaseModel):
    version: int | None = Field(description="seed version the run used; null before Stage 3")
    hash: str | None = Field(description="seed hash pinned for the run; null when unverified")


class ReproTranscriptRow(BaseModel):
    index: int = Field(ge=0)
    step_id: UUID
    ask: str | None
    answer: str | None
    label: str


class ReproBase(BaseModel):
    finding_id: UUID
    run_id: UUID
    run_scenario_id: UUID
    attempt: int = Field(ge=0)
    bundle_version: int = Field(ge=1)
    scenario_id: UUID
    scenario_version: int = Field(ge=1)
    scenario_yaml: str = Field(description="the scenario version the run executed")
    seed: ReproSeed
    clock: ClockSnapshot
    browser_session_id: UUID | None
    transcript: list[ReproTranscriptRow]
    expected: JsonValue
    actual: JsonValue
    oracle_rows: list[dict[str, JsonValue]] = Field(
        max_length=REPRO_MAX_ORACLE_ROWS, description="at most 20 oracle rows, secrets redacted"
    )
    invariant_id: str | None


class FindingRepro(ReproBase):
    screencast: list[ArtifactRef] = Field(
        description="recordings and screenshots with signed URLs minted at read time"
    )


class StoredFindingRepro(ReproBase):
    schema_version: Literal[1] = Field(description="version of this document")
    screencast: list[StoredArtifact] = Field(
        description="artifact ids; the API signs them into ArtifactRef when it serves the repro"
    )
