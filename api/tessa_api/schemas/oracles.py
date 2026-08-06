from uuid import UUID

from pydantic import BaseModel, Field, JsonValue

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import (
    OracleApproval,
    OracleLanguage,
    OracleResultStatus,
    VerdictStatus,
)


class OracleTemplate(BaseModel):
    id: UUID
    bundle_id: UUID
    name: str = Field(description="oracle name, equal to the sidecar file name without extension")
    feature_ids: list[str] = Field(
        description="manifest features whose expected result it computes"
    )
    language: OracleLanguage
    source: str = Field(description="query or script text, placeholders only")
    params_schema: dict[str, JsonValue] = Field(
        description="JSON Schema of the parameters; a property may carry x-source"
    )
    sentence_template: str = Field(description="Jinja2 template that renders the expected sentence")
    read_only_verified: bool = Field(description="true when the oracle lint proved it read-only")
    approval: OracleApproval = Field(description="only approved oracles may drive a verdict")


class OracleTemplatePage(BaseModel):
    items: list[OracleTemplate]
    next_cursor: str | None
    total: int | None


class OracleRunCreate(BaseModel):
    params: dict[str, JsonValue] = Field(
        description="parameter values, validated against the schema"
    )


class OracleResult(BaseModel):
    id: UUID
    oracle_template_id: UUID
    params: dict[str, JsonValue]
    status: OracleResultStatus
    rows: list[dict[str, JsonValue]] = Field(
        description="result rows, at most TESSA_ORACLE_MAX_ROWS"
    )
    rows_truncated: bool = Field(description="true when more rows existed than were kept")
    sentence: str | None = Field(description="rendered expected sentence; null until rendered")
    error: str | None = Field(description="redacted failure message; never a connection string")
    duration_ms: int | None = Field(ge=0, description="query duration; null while pending")
    executed_at: Timestamp | None = Field(description="when the query ran; null while pending")


class OracleResultPage(BaseModel):
    items: list[OracleResult]
    next_cursor: str | None
    total: int | None


class OracleApprovalSet(BaseModel):
    approved: bool = Field(description="true approves the oracle, false rejects it")
    oracle_result_id: UUID = Field(description="result the reviewer looked at before deciding")


class GoldPoint(BaseModel):
    key: str = Field(description="gold point key, interpolated as ${gold.<key>}")
    value: JsonValue = Field(description="value derived from the oracle rows")
    oracle_result_id: UUID = Field(description="oracle result the value came from")
    rendered: str = Field(description="value rendered as text for matching and for the judge")


class DbCheck(BaseModel):
    name: str = Field(description="name of the expectation")
    expected: JsonValue = Field(description="expected value after the step")
    actual: JsonValue = Field(description="value read from the truth database")
    status: VerdictStatus
    oracle_result_id: UUID | None = Field(description="oracle result that supplied actual")
