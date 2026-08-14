from uuid import UUID

from pydantic import BaseModel, Field

RESOLVE_FINDINGS = "resolve_findings"


class ResolveFindingsInput(BaseModel):
    run_id: UUID


class ResolveFindingsResult(BaseModel):
    resolved_finding_ids: list[UUID] = Field(
        description="findings moved to resolved because a later run executed their scenario or "
        "family and everything passed"
    )
