from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Probability, Timestamp
from tessa_api.schemas.enums import MutationOutcome, RunStatus
from tessa_api.schemas.mutants import MUTANT_BASE_URL_MAX_LENGTH, MUTANT_BASE_URL_PATTERN


class MutationRunCreate(BaseModel):
    target_id: UUID
    mutant_id: UUID
    plan_id: UUID = Field(description="saved plan the suite runs against the mutant")
    base_url_override: str | None = Field(
        default=None,
        max_length=MUTANT_BASE_URL_MAX_LENGTH,
        pattern=MUTANT_BASE_URL_PATTERN,
        description="deployed address of the mutant for this run; replaces the mutant base_url "
        "and may not match a production URL pattern",
    )


class MutationOutcomeItem(BaseModel):
    invariant_id: str
    outcome: MutationOutcome
    caught_by: list[UUID] = Field(
        description="scenario ids that failed against the mutant and not against the baseline"
    )


class MutationRun(BaseModel):
    id: UUID
    run_id: UUID = Field(description="run row of kind mutation that carries the events")
    mutant_id: UUID
    plan_id: UUID
    baseline_run_id: UUID | None = Field(
        description="completed suite run the kill rule subtracted; null until it is chosen"
    )
    status: RunStatus = Field(description="status of the mutation run row")
    outcomes: list[MutationOutcomeItem] = Field(
        description="one entry per expected catcher; empty until the run is scored"
    )
    power: Probability | None = Field(
        description="killed catchers divided by killed plus survived; null until scored or when "
        "no catcher decided"
    )
    started_at: Timestamp
    finished_at: Timestamp | None


class MutationRunPage(BaseModel):
    items: list[MutationRun]
    next_cursor: str | None
    total: int | None


class MutationSurvivor(BaseModel):
    mutant_id: UUID
    name: str
    invariant_ids: list[str] = Field(description="expected catchers that did not catch the bug")


class MutationInvariantPower(BaseModel):
    invariant_id: str
    killed: int = Field(ge=0, description="mutants this invariant caught in their latest run")
    survived: int = Field(
        ge=0, description="mutants it was expected to catch in their latest run and did not"
    )


class MutationSummary(BaseModel):
    suite_power: Probability | None = Field(
        description="killed mutants divided by total, from the latest run of each mutant; null "
        "when total is 0"
    )
    killed: int = Field(ge=0)
    total: int = Field(ge=0, description="mutants the summary counts, one latest run each")
    survivors: list[MutationSurvivor]
    per_invariant: list[MutationInvariantPower]
