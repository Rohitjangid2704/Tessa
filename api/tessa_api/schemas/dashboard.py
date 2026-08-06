from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Probability, Timestamp
from tessa_api.schemas.runs import RunSummary


class SeverityCounts(BaseModel):
    critical: int = Field(ge=0)
    high: int = Field(ge=0)
    medium: int = Field(ge=0)
    low: int = Field(ge=0)
    info: int = Field(ge=0)


class LastNightly(BaseModel):
    run_id: UUID
    pass_hat_k: Probability | None = Field(
        description="pass^k of the run; null when no scenario finished"
    )
    finished_at: Timestamp


class DashboardSummary(BaseModel):
    last_nightly: LastNightly | None = Field(
        description="latest finished run started by a nightly schedule; null when there is none"
    )
    open_findings_by_severity: SeverityCounts = Field(
        description="open findings of the target, or of every target, counted per severity"
    )
    cost_week_usd: float = Field(ge=0, description="spend of the rolling last 7 days in USD")
    suite_power: Probability | None = Field(
        description="share of known bugs the suite kills; null when no mutant has run"
    )
    kappa: float | None = Field(
        ge=-1,
        le=1,
        description="agreement of the machine verdicts with human labels; null below the "
        "minimum label count",
    )
    last_runs: list[RunSummary]
