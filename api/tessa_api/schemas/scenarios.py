from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp, Verdict
from tessa_api.schemas.enums import (
    Effort,
    ReviewDecision,
    ScenarioOrigin,
    ScenarioPatchStatus,
    ScenarioStatus,
)

SCENARIO_NOTE_MAX_LENGTH = 1000


class ScenarioIssue(BaseModel):
    code: str = Field(description="stable machine readable problem code")
    pointer: str | None = Field(description="JSON pointer into the scenario document")
    line: int | None = Field(description="line of the problem in the YAML, from 1")
    column: int | None = Field(description="column of the problem in the YAML, from 1")
    message: str = Field(description="what is wrong and how to fix it")


class ScenarioValidation(BaseModel):
    valid: bool = Field(description="true when there are no errors")
    errors: list[ScenarioIssue]
    warnings: list[ScenarioIssue]


class ScenarioSummary(BaseModel):
    id: UUID
    target_id: UUID
    bundle_id: UUID
    feature_id: str | None
    cell_id: UUID | None
    title: str
    family: str
    origin: ScenarioOrigin
    status: ScenarioStatus
    version: int = Field(ge=1, description="current version of the scenario, from 1")
    synthetic: bool = Field(description="true for scenarios Tessa generates itself")
    validation: ScenarioValidation
    provenance: dict[str, Any] | None
    created_at: Timestamp
    updated_at: Timestamp


class Scenario(ScenarioSummary):
    yaml: str = Field(description="the scenario document as stored")
    parsed: dict[str, Any] = Field(description="the document parsed and normalised")


class ScenarioSummaryPage(BaseModel):
    items: list[ScenarioSummary]
    next_cursor: str | None
    total: int | None


class ScenarioCreate(BaseModel):
    target_id: UUID
    yaml: str = Field(min_length=1, description="the scenario document")


class ScenarioUpdate(BaseModel):
    yaml: str = Field(min_length=1, description="the new scenario document")
    base_version: int = Field(
        ge=1, description="version the edit started from; a newer stored version is a 409"
    )


class ScenarioPatch(BaseModel):
    status: ScenarioPatchStatus = Field(description="retire, quarantine or accept the scenario")


class ScenarioValidateRequest(BaseModel):
    target_id: UUID
    yaml: str = Field(description="the scenario document to check, nothing is saved")


class ScenarioReviewCreate(BaseModel):
    decision: ReviewDecision
    note: str | None = Field(default=None, max_length=SCENARIO_NOTE_MAX_LENGTH)


class ScenarioGenerator(BaseModel):
    model: str = Field(description="model id, or stub when TESSA_STUB_MODELS is on")
    effort: Effort
    template_version: int = Field(ge=1, description="version of the generation template")


class ScenarioDryRun(BaseModel):
    run_id: UUID
    run_scenario_id: UUID
    verdict: Verdict


class ScenarioProvenance(BaseModel):
    cell_id: UUID | None
    bundle_id: UUID
    bundle_version: int = Field(ge=1)
    finding_id: UUID | None
    ticket_url: str | None
    prompt_issue_id: UUID | None
    generator: ScenarioGenerator | None = Field(description="null for scenarios no model wrote")
    dry_runs: list[ScenarioDryRun]
    created_at: Timestamp


class ScenarioVersion(BaseModel):
    scenario_id: UUID
    version: int = Field(ge=1)
    yaml: str
    parsed: dict[str, Any]
    created_by: UUID | None
    created_at: Timestamp
    note: str | None


class ScenarioVersionPage(BaseModel):
    items: list[ScenarioVersion]
    next_cursor: str | None
    total: int | None
