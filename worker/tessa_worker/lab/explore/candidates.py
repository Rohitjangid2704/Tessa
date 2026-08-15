import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import ExplorationCandidateRow
from tessa_api.ids import new_id
from tessa_api.schemas.enums import CandidateSource, CandidateStatus
from tessa_api.schemas.explore_actions import FinishAction, SnapshotAssertion
from tessa_api.schemas.streams import (
    ExploreCandidatePayload,
    ExploreVerifiedPayload,
    IngestEvent,
)
from tessa_worker.event_client import build_event
from tessa_worker.lab.contracts import CandidateDraft

DESCRIPTION_CHARS = 1000


@dataclass(frozen=True, slots=True)
class CandidateView:
    id: uuid.UUID
    run_id: uuid.UUID
    run_scenario_id: uuid.UUID
    source: CandidateSource
    detector: str | None
    description: str
    from_index: int
    to_index: int
    assertion: SnapshotAssertion
    status: CandidateStatus
    finding_id: uuid.UUID | None


def claim_draft(action: FinishAction, from_index: int, to_index: int) -> CandidateDraft | None:
    if action.claim is None or action.assertion is None:
        return None
    return CandidateDraft(
        source=CandidateSource.model_claim,
        detector=None,
        description=action.claim,
        from_index=from_index,
        to_index=to_index,
        assertion=action.assertion,
    )


def view_of(row: ExplorationCandidateRow) -> CandidateView:
    return CandidateView(
        id=row.id,
        run_id=row.run_id,
        run_scenario_id=row.run_scenario_id,
        source=row.source,
        detector=row.detector,
        description=row.description,
        from_index=row.from_index,
        to_index=row.to_index,
        assertion=SnapshotAssertion.model_validate(row.assertion),
        status=row.status,
        finding_id=row.finding_id,
    )


async def insert_candidate(
    session: AsyncSession,
    run_id: uuid.UUID,
    run_scenario_id: uuid.UUID,
    draft: CandidateDraft,
    status: CandidateStatus,
) -> CandidateView:
    row = ExplorationCandidateRow(
        id=new_id(),
        run_id=run_id,
        run_scenario_id=run_scenario_id,
        source=draft.source,
        detector=draft.detector,
        description=draft.description[:DESCRIPTION_CHARS],
        from_index=draft.from_index,
        to_index=draft.to_index,
        assertion=draft.assertion.model_dump(mode="json"),
        status=status,
    )
    session.add(row)
    await session.flush()
    return view_of(row)


async def load_candidate(session: AsyncSession, candidate_id: uuid.UUID) -> CandidateView | None:
    row = await session.get(ExplorationCandidateRow, candidate_id)
    return None if row is None else view_of(row)


async def lock_candidate(
    session: AsyncSession, candidate_id: uuid.UUID
) -> ExplorationCandidateRow | None:
    return await session.scalar(
        select(ExplorationCandidateRow)
        .where(ExplorationCandidateRow.id == candidate_id)
        .with_for_update()
    )


async def settle_candidate(
    session: AsyncSession,
    row: ExplorationCandidateRow,
    status: CandidateStatus,
    finding_id: uuid.UUID | None,
) -> None:
    row.status = status
    row.finding_id = finding_id
    row.verified_at = datetime.now(UTC)
    await session.flush()


async def settle_pending(
    session: AsyncSession, run_id: uuid.UUID, status: CandidateStatus
) -> list[uuid.UUID]:
    settled = await session.scalars(
        update(ExplorationCandidateRow)
        .where(
            ExplorationCandidateRow.run_id == run_id,
            ExplorationCandidateRow.status == CandidateStatus.pending,
        )
        .values(status=status, verified_at=datetime.now(UTC))
        .returning(ExplorationCandidateRow.id)
    )
    return list(settled)


async def pending_candidate_ids(session: AsyncSession, run_id: uuid.UUID) -> list[uuid.UUID]:
    rows = await session.scalars(
        select(ExplorationCandidateRow.id)
        .where(
            ExplorationCandidateRow.run_id == run_id,
            ExplorationCandidateRow.status == CandidateStatus.pending,
        )
        .order_by(ExplorationCandidateRow.created_at, ExplorationCandidateRow.id)
    )
    return list(rows)


def candidate_event(candidate: CandidateView) -> IngestEvent:
    return build_event(
        candidate.run_id,
        "explore.candidate",
        ExploreCandidatePayload(
            candidate_id=candidate.id,
            description=candidate.description,
            from_index=candidate.from_index,
            to_index=candidate.to_index,
        ),
        f"explore.candidate:{candidate.id}",
    )


def verified_event(
    run_id: uuid.UUID,
    candidate_id: uuid.UUID,
    verified: bool,
    replay_run_scenario_id: uuid.UUID | None,
    finding_id: uuid.UUID | None,
) -> IngestEvent:
    return build_event(
        run_id,
        "explore.verified",
        ExploreVerifiedPayload(
            candidate_id=candidate_id,
            verified=verified,
            replay_run_scenario_id=replay_run_scenario_id,
            finding_id=finding_id,
        ),
        f"explore.verified:{candidate_id}",
    )
