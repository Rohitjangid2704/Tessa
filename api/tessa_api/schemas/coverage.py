from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.plans import CoverageCell


class CoverageRow(BaseModel):
    feature_id: str
    area: str
    title: str


class CoverageColumn(BaseModel):
    role: str
    interface_id: str


class CoverageTotals(BaseModel):
    empty: int = Field(ge=0)
    generated: int = Field(ge=0)
    covered: int = Field(ge=0)
    needs_author: int = Field(ge=0)
    blocked: int = Field(ge=0)


class CoverageMap(BaseModel):
    target_id: UUID
    plan_id: UUID = Field(
        description="the resolved plan, always echoed; the hidden baseline plan when none is given"
    )
    bundle_id: UUID
    rows: list[CoverageRow]
    columns: list[CoverageColumn]
    cells: list[CoverageCell]
    totals: CoverageTotals = Field(description="cells by status over the returned cells")
