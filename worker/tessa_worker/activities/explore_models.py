from typing import Literal
from uuid import UUID

from pydantic import BaseModel

SETTLE_PENDING_CANDIDATES = "settle_pending_candidates"


class SettlePendingCandidatesInput(BaseModel):
    run_id: UUID
    status: Literal["discarded", "unverified"]


class SettlePendingCandidatesResult(BaseModel):
    candidate_ids: list[UUID]
