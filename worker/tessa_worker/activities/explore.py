from temporalio import activity

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import CandidateStatus
from tessa_worker.activities.explore_models import (
    SETTLE_PENDING_CANDIDATES,
    SettlePendingCandidatesInput,
    SettlePendingCandidatesResult,
)
from tessa_worker.lab.explore.candidates import settle_pending


class ExploreActivities:
    def __init__(self, session_factory: SessionFactory) -> None:
        self.session_factory = session_factory

    @activity.defn(name=SETTLE_PENDING_CANDIDATES)
    async def settle_pending_candidates(
        self, request: SettlePendingCandidatesInput
    ) -> SettlePendingCandidatesResult:
        async with self.session_factory() as session:
            settled = await settle_pending(session, request.run_id, CandidateStatus(request.status))
            await session.commit()
        return SettlePendingCandidatesResult(candidate_ids=settled)
