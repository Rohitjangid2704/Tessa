from typing import Self
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from tessa_api.schemas.common import Probability, Timestamp
from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
    VerdictStatus,
    VerdictTier,
)

INVARIANT_PACK_BY_ID: dict[BuiltInInvariantId, InvariantPack] = {
    BuiltInInvariantId.no_5xx: InvariantPack.generic,
    BuiltInInvariantId.no_console_errors: InvariantPack.generic,
    BuiltInInvariantId.auth_boundaries: InvariantPack.generic,
    BuiltInInvariantId.role_monotonicity: InvariantPack.generic,
    BuiltInInvariantId.tenant_isolation: InvariantPack.generic,
    BuiltInInvariantId.idempotent_writes: InvariantPack.generic,
    BuiltInInvariantId.pii_by_role: InvariantPack.generic,
    BuiltInInvariantId.accessibility: InvariantPack.generic,
    BuiltInInvariantId.latency: InvariantPack.generic,
    BuiltInInvariantId.no_save_claim_before_confirm: InvariantPack.llm_app,
    BuiltInInvariantId.no_internal_ids: InvariantPack.llm_app,
    BuiltInInvariantId.external_facts_labelled: InvariantPack.llm_app,
    BuiltInInvariantId.refuses_out_of_scope: InvariantPack.llm_app,
    BuiltInInvariantId.injection_resistance: InvariantPack.llm_app,
    BuiltInInvariantId.authority_pressure: InvariantPack.llm_app,
    BuiltInInvariantId.count_consistency: InvariantPack.llm_app,
    BuiltInInvariantId.empty_set_honesty: InvariantPack.llm_app,
}

ACTIVE_INVARIANT_IDS: frozenset[BuiltInInvariantId] = frozenset(
    {
        BuiltInInvariantId.auth_boundaries,
        BuiltInInvariantId.role_monotonicity,
        BuiltInInvariantId.tenant_isolation,
        BuiltInInvariantId.idempotent_writes,
        BuiltInInvariantId.refuses_out_of_scope,
        BuiltInInvariantId.injection_resistance,
        BuiltInInvariantId.authority_pressure,
    }
)

PASSIVE_INVARIANT_IDS: frozenset[BuiltInInvariantId] = frozenset(
    set(BuiltInInvariantId) - ACTIVE_INVARIANT_IDS
)


class InvariantInfo(BaseModel):
    id: str = Field(description="invariant slug; built-in ids or an id the bundle declares")
    pack: InvariantPack
    title: str = Field(description="short name for filters and result labels")
    description: str = Field(description="one sentence on what the invariant guarantees")
    check: InvariantCheck = Field(description="how the invariant is evaluated")


class InvariantCatalog(BaseModel):
    items: list[InvariantInfo]


class InvariantResult(BaseModel):
    id: UUID
    run_id: UUID
    run_scenario_id: UUID | None
    step_id: UUID | None
    attempt: int | None = Field(
        ge=0, description="attempt number from 0; null for run-level results"
    )
    invariant_id: str
    pack: InvariantPack
    status: VerdictStatus
    tier: VerdictTier
    confidence: Probability | None
    message: str = Field(description="short redacted explanation of the result")
    skip_reason: SkipReason | None = Field(description="set exactly when status is skipped")
    created_at: Timestamp

    @model_validator(mode="after")
    def skip_reason_matches_status(self) -> Self:
        if (self.status is VerdictStatus.skipped) != (self.skip_reason is not None):
            raise ValueError("skip_reason is set exactly when status is skipped")
        return self


class InvariantResultPage(BaseModel):
    items: list[InvariantResult]
    next_cursor: str | None
    total: int | None
