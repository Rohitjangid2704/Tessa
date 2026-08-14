from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.enums import SeedHashSource, SeedResetStatus


class OpenSeedRunInput(BaseModel):
    run_id: UUID
    seed_id: UUID


class OpenSeedRunResult(BaseModel):
    owns_run: bool = Field(
        description="true when the run is a seed run of this workflow; false for a suite run "
        "that runs SeedTarget as a child and keeps its own status"
    )
    declared_hash: str | None
    hash_source: SeedHashSource


class RecordSeedOutcomeInput(BaseModel):
    run_id: UUID
    seed_id: UUID
    status: SeedResetStatus
    observed_hash: str | None
    pin_first_reset: bool = Field(
        description="record observed_hash as declared_hash with hash_source first_reset when the "
        "seed has no declared hash yet"
    )


class RecordSeedOutcomeResult(BaseModel):
    declared_hash: str | None
    hash_source: SeedHashSource
