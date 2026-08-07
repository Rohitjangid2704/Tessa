import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import FindingOccurrenceRow, FindingRow, RunRow
from tessa_api.ids import new_id
from tessa_api.schemas.common import EMBEDDING_DIMENSIONS
from tessa_api.schemas.enums import FindingStatus
from tessa_api.schemas.streams import IngestEvent
from tessa_api.schemas.temporal import FindingCandidate, UpsertDecision
from tessa_api.services.findings.events import (
    created_event,
    occurrence_added_event,
    updated_event,
)
from tessa_api.services.findings.lifecycle import Changes, move_to, status_after_occurrence

POSSIBLE_DUPLICATE_KEY = "possible_duplicate_of"
DEDUPE_KEY = "dedupe"
MERGE_EVIDENCE_KINDS = frozenset({"semantic", "uncertain"})


class UpsertTargetMissingError(LookupError):
    pass


@dataclass(frozen=True, slots=True)
class UpsertOutcome:
    created_ids: tuple[uuid.UUID, ...]
    updated_ids: tuple[uuid.UUID, ...]
    occurrences_added: int
    known_gap_hits: int
    needs_repro: tuple[uuid.UUID, ...]
    events: tuple[IngestEvent, ...]


@dataclass(frozen=True, slots=True)
class Located:
    row: FindingRow
    created: bool


def occurrence_evidence(decision: UpsertDecision) -> dict[str, Any]:
    candidate = decision.candidate
    evidence: dict[str, Any] = {
        **candidate.evidence,
        "signal": candidate.signal,
        "expected": candidate.expected,
        "actual": candidate.actual,
    }
    match = decision.match
    if match.possible_duplicate_of is not None:
        evidence[POSSIBLE_DUPLICATE_KEY] = str(match.possible_duplicate_of)
    if match.kind in MERGE_EVIDENCE_KINDS:
        evidence[DEDUPE_KEY] = {
            "kind": match.kind,
            "similarity": None if match.similarity is None else round(match.similarity, 4),
            "fingerprint": candidate.fingerprint,
        }
    return evidence


def usable_embedding(candidate: FindingCandidate) -> list[float] | None:
    embedding = candidate.embedding
    if embedding is None or len(embedding) != EMBEDDING_DIMENSIONS:
        return None
    return list(embedding)


def new_finding_row(
    run_id: uuid.UUID, target_id: uuid.UUID, candidate: FindingCandidate
) -> FindingRow:
    return FindingRow(
        id=new_id(),
        target_id=target_id,
        fingerprint=candidate.fingerprint,
        title=candidate.title,
        class_=candidate.finding_class,
        severity=candidate.severity,
        status=FindingStatus.new,
        invariant_id=candidate.invariant_id,
        scenario_id=candidate.scenario_id,
        first_seen_run_id=run_id,
        last_seen_run_id=run_id,
        embedding=usable_embedding(candidate),
    )


async def lock_by_fingerprint(
    session: AsyncSession, target_id: uuid.UUID, fingerprint: str
) -> FindingRow | None:
    return await session.scalar(
        select(FindingRow)
        .where(FindingRow.target_id == target_id, FindingRow.fingerprint == fingerprint)
        .with_for_update()
    )


async def create_or_attach(
    session: AsyncSession, run_id: uuid.UUID, target_id: uuid.UUID, candidate: FindingCandidate
) -> Located:
    row = new_finding_row(run_id, target_id, candidate)
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        existing = await lock_by_fingerprint(session, target_id, candidate.fingerprint)
        if existing is None:
            raise
        return Located(existing, created=False)
    return Located(row, created=True)


async def locate(
    session: AsyncSession, run_id: uuid.UUID, target_id: uuid.UUID, decision: UpsertDecision
) -> Located:
    matched_id = decision.match.finding_id
    if matched_id is not None:
        row = await session.get(FindingRow, matched_id, with_for_update=True)
        if row is not None and row.target_id == target_id:
            return Located(row, created=False)
    existing = await lock_by_fingerprint(session, target_id, decision.candidate.fingerprint)
    if existing is not None:
        return Located(existing, created=False)
    return await create_or_attach(session, run_id, target_id, decision.candidate)


async def add_occurrence(
    session: AsyncSession, row: FindingRow, run_id: uuid.UUID, decision: UpsertDecision
) -> bool:
    candidate = decision.candidate
    inserted = await session.scalar(
        insert(FindingOccurrenceRow)
        .values(
            id=new_id(),
            finding_id=row.id,
            run_id=run_id,
            run_scenario_id=candidate.run_scenario_id,
            step_id=candidate.step_id,
            attempt=candidate.attempt,
            evidence=occurrence_evidence(decision),
        )
        .on_conflict_do_nothing()
        .returning(FindingOccurrenceRow.id)
    )
    return inserted is not None


async def count_occurrences(session: AsyncSession, finding_id: uuid.UUID) -> int:
    count = await session.scalar(
        select(func.count())
        .select_from(FindingOccurrenceRow)
        .where(FindingOccurrenceRow.finding_id == finding_id)
    )
    return int(count or 0)


def occurrence_identity(
    finding_id: uuid.UUID, candidate: FindingCandidate
) -> tuple[uuid.UUID, uuid.UUID | None, uuid.UUID | None, int | None]:
    return finding_id, candidate.run_scenario_id, candidate.step_id, candidate.attempt


class BatchUpsert:
    def __init__(self, session: AsyncSession, run_id: uuid.UUID, target_id: uuid.UUID) -> None:
        self.session = session
        self.run_id = run_id
        self.target_id = target_id
        self.touched: dict[uuid.UUID, FindingRow] = {}
        self.fresh_occurrences: set[uuid.UUID] = set()
        self.reopened: set[uuid.UUID] = set()
        self.identities: set[tuple[uuid.UUID, uuid.UUID | None, uuid.UUID | None, int | None]] = (
            set()
        )
        self.events: list[IngestEvent] = []

    async def apply(self, decision: UpsertDecision) -> None:
        located = await locate(self.session, self.run_id, self.target_id, decision)
        row = located.row
        self.touched[row.id] = row
        inserted = await add_occurrence(self.session, row, self.run_id, decision)
        self.identities.add(occurrence_identity(row.id, decision.candidate))
        if located.created:
            return
        if row.embedding is None:
            row.embedding = usable_embedding(decision.candidate)
        if inserted:
            self.fresh_occurrences.add(row.id)
            self.register_recurrence(row)

    def register_recurrence(self, row: FindingRow) -> None:
        now = datetime.now(UTC)
        row.last_seen_run_id = self.run_id
        row.last_seen_at = now
        moved = status_after_occurrence(row.status)
        if moved is row.status:
            return
        changes: Changes = {"status": (row.status.value, moved.value)}
        move_to(row, moved, now)
        self.events.append(updated_event(row.id, changes))
        if moved is FindingStatus.new:
            self.reopened.add(row.id)

    async def refresh_counts(self) -> None:
        for finding_id, row in self.touched.items():
            row.occurrence_count = await count_occurrences(self.session, finding_id)
        await self.session.flush()

    def outcome(self) -> UpsertOutcome:
        created = [fid for fid, row in self.touched.items() if row.first_seen_run_id == self.run_id]
        created_set = set(created)
        updated = [fid for fid in self.touched if fid not in created_set]
        known_gap_hits = sum(
            self.touched[fid].status is FindingStatus.known_gap
            for fid in updated
            if fid in self.fresh_occurrences
        )
        needs_repro = [
            fid for fid, row in self.touched.items() if row.repro is None or fid in self.reopened
        ]
        return UpsertOutcome(
            created_ids=tuple(created),
            updated_ids=tuple(updated),
            occurrences_added=len(self.identities),
            known_gap_hits=known_gap_hits,
            needs_repro=tuple(needs_repro),
            events=tuple(self.delivery_events()),
        )

    def delivery_events(self) -> list[IngestEvent]:
        creations = [
            created_event(self.run_id, row, row.first_seen_run_id == self.run_id)
            for row in self.touched.values()
        ]
        recurrences = [
            occurrence_added_event(
                self.run_id, finding_id, self.touched[finding_id].occurrence_count
            )
            for finding_id in self.touched
            if finding_id in self.fresh_occurrences
        ]
        return [*creations, *recurrences, *self.events]


async def upsert_decisions(
    session: AsyncSession, run_id: uuid.UUID, decisions: Sequence[UpsertDecision]
) -> UpsertOutcome:
    run = await session.get(RunRow, run_id)
    if run is None or run.target_id is None:
        raise UpsertTargetMissingError(f"run {run_id} does not exist or has no target")
    batch = BatchUpsert(session, run_id, run.target_id)
    for decision in sorted(decisions, key=lambda item: item.candidate.fingerprint):
        await batch.apply(decision)
    await batch.refresh_counts()
    return batch.outcome()
