from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from tessa_api.schemas.common import Probability, Verdict
from tessa_api.schemas.enums import InvariantPack, RunDiffCategory


class FamilyStats(BaseModel):
    family: str
    scenarios: int = Field(ge=0, description="finished and skipped run scenarios of the family")
    pass_hat_k: Probability | None = Field(
        description="fraction of the family's finished scenarios whose k attempts all passed"
    )
    flaky: int = Field(ge=0)
    uncertain: int = Field(ge=0)
    skipped: int = Field(ge=0)


class InvariantStats(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    invariant_id: str
    pack: InvariantPack
    pass_: int = Field(ge=0, alias="pass")
    fail: int = Field(ge=0)
    flaky: int = Field(ge=0)
    uncertain: int = Field(ge=0)
    skipped: int = Field(ge=0)


class LatencyPercentiles(BaseModel):
    p50: int = Field(ge=0, description="median step latency in milliseconds")
    p90: int = Field(ge=0)
    p99: int = Field(ge=0)


class CostPercentiles(BaseModel):
    total: float = Field(ge=0, description="money spent by the run in USD")
    p50: float = Field(ge=0, description="median cost of a run scenario in USD")
    p90: float = Field(ge=0)


class TierMix(BaseModel):
    code: int = Field(ge=0, description="verdicts decided by code")
    laya: int = Field(ge=0)
    judge: int = Field(ge=0)
    human: int = Field(ge=0)


class RunStats(BaseModel):
    k: int = Field(ge=1, le=10, description="attempts per scenario the run used")
    pass_hat_k: Probability | None = Field(
        description="fraction of all finished scenarios whose k attempts all passed; null when "
        "none finished"
    )
    flaky_rate: Probability | None = Field(
        description="fraction of finished scenarios with a flaky verdict; null when none finished"
    )
    open_findings: int = Field(ge=0, description="findings of the target that are not closed")
    families: list[FamilyStats]
    invariants: list[InvariantStats]
    latency_ms: LatencyPercentiles
    cost_usd: CostPercentiles
    tiers: TierMix


class RunDiffItem(BaseModel):
    scenario_id: UUID
    title: str
    family: str
    role: str
    interface_id: str
    run_scenario_id: UUID | None = Field(description="run scenario of this run; null when removed")
    against_run_scenario_id: UUID | None = Field(
        description="run scenario of the compared run; null when added"
    )
    before: Verdict | None = Field(description="verdict in the compared run")
    after: Verdict | None = Field(description="verdict in this run")
    comparable: bool = Field(
        description="false when the scenario version differs or one side has no verdict"
    )
    category: RunDiffCategory


class RunDiff(BaseModel):
    new_failures: list[UUID] = Field(description="scenario ids of comparable new failures")
    fixed: list[UUID] = Field(description="scenario ids of comparable fixes")
    still_failing: list[UUID] = Field(description="scenario ids that fail in both runs")
    flaky_changes: list[UUID] = Field(description="scenario ids whose flakiness changed")
    cost_delta_usd: float = Field(description="this run's spend minus the compared run's")
    latency_p50_delta_ms: int = Field(description="this run's p50 latency minus the compared run's")
    items: list[RunDiffItem]
