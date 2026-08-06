from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Budget, Timestamp
from tessa_api.schemas.enums import CellStatus, Depth, InterfaceMode, SkipReason, VerdictStatus


class PlanSelection(BaseModel):
    feature_ids: list[str] = Field(
        default_factory=list, description="catalog features to cover, by manifest feature id"
    )
    area_ids: list[str] = Field(
        default_factory=list, description="catalog areas to cover; every feature of an area"
    )
    roles: list[str] = Field(
        default_factory=list, description="manifest role ids to run as; all means every role"
    )
    interface_mode: InterfaceMode = Field(
        description="api_only is every interface kind except browser"
    )
    depth: Depth = Field(description="smoke, standard or deep")
    k: int = Field(ge=1, le=10, description="attempts per scenario")
    budget: Budget | None = Field(
        default=None, description="when absent the server applies its defaults"
    )


class PlanCreate(BaseModel):
    target_id: UUID
    bundle_id: UUID | None = Field(
        default=None, description="bundle to plan against; default is the latest valid one"
    )
    name: str | None = Field(default=None, min_length=1, max_length=120)
    saved: bool = Field(description="true keeps the plan in the saved plans list")
    selection: PlanSelection
    include_api_fuzz: bool = Field(
        default=False,
        description="adds a Schemathesis family of one synthetic scenario per role "
        "from the bundle openapi.json",
    )


class PlanUpdate(BaseModel):
    name: str | None = Field(
        default=None,
        min_length=1,
        max_length=120,
        description="new name; an explicit null clears the name",
    )
    selection: PlanSelection | None = Field(
        default=None, description="new selection; cells are rebuilt"
    )


class PlanSkippedItem(BaseModel):
    feature_id: str
    role: str | None = Field(
        description="role of the skipped cell; null when the skip is feature wide"
    )
    interface_id: str | None = Field(
        description="interface of the skipped cell; null when the skip is feature wide"
    )
    reason: SkipReason


class PlanPreview(BaseModel):
    cells_total: int = Field(ge=0, description="cells the selection expands to")
    scenarios_estimated: int = Field(ge=0, description="scenarios the cells would run")
    skipped: list[PlanSkippedItem]
    warnings: list[str]
    effective_budget: Budget = Field(description="selection budget or the server defaults")
    estimated_cost_usd: float | None = Field(
        description="cells times TESSA_PLAN_ESTIMATE_COST_PER_CELL_USD from Stage 6; null "
        "before"
    )


class Plan(BaseModel):
    id: UUID
    target_id: UUID
    bundle_id: UUID
    name: str | None
    saved: bool
    selection: PlanSelection
    effective_budget: Budget = Field(description="selection budget or the server defaults")
    is_coverage_baseline: bool = Field(
        description="true for the hidden plan the coverage map reads; never listed"
    )
    include_api_fuzz: bool = Field(
        default=False, description="true when runs of the plan include the api fuzz family"
    )
    cells_total: int = Field(ge=0)
    schedule_id: UUID | None = Field(
        description="newest schedule of the plan; a plan may carry several (commit, nightly, "
        "weekly), list them with GET /schedules?plan_id=; null when none exists"
    )
    created_by: UUID
    created_at: Timestamp


class PlanPage(BaseModel):
    items: list[Plan]
    next_cursor: str | None
    total: int | None


class CoverageCell(BaseModel):
    id: UUID
    plan_id: UUID
    feature_id: str
    role: str
    interface_id: str
    family: str
    status: CellStatus
    scenario_count: int = Field(ge=0)
    last_verdict: VerdictStatus | None
    reason: str | None = Field(description="why a cell is needs_author or blocked")
    skip_reason: SkipReason | None = Field(description="set when status is blocked")
    proposal_item_ids: list[UUID] = Field(
        default_factory=list,
        description="items of the current proposal that map to the cell and were not declined; "
        "filled by GET /coverage, empty elsewhere",
    )


class CoverageCellPage(BaseModel):
    items: list[CoverageCell]
    next_cursor: str | None
    total: int | None
