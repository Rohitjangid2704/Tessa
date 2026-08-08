from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import RunEventRow, RunRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.events import EventEnvelope
from tessa_api.schemas.streams import IngestEvent, IngestEventResult
from tessa_api.streams.hub import Hub

ADVISORY_LOCK_STATEMENT = text("SELECT pg_advisory_xact_lock(hashtextextended(:run_id, 0))")


@dataclass(frozen=True, slots=True)
class RunAppend:
    seqs: dict[int, int]
    inserted: list[EventEnvelope]


def durable_identity(event: IngestEvent) -> tuple[UUID, str]:
    if event.run_id is None or not event.dedupe_key:
        raise ValueError("a durable event needs run_id and dedupe_key")
    return event.run_id, event.dedupe_key


def event_envelope(seq: int | None, event: IngestEvent) -> EventEnvelope:
    return EventEnvelope(
        type=event.type,
        run_id=event.run_id,
        seq=seq,
        ts=event.occurred_at,
        payload=event.payload,
    )


async def append_to_run(
    session: AsyncSession, run_id: UUID, indexed_events: Sequence[tuple[int, IngestEvent]]
) -> RunAppend:
    await session.execute(ADVISORY_LOCK_STATEMENT, {"run_id": str(run_id)})
    current_max = await session.scalar(
        select(func.coalesce(func.max(RunEventRow.seq), 0)).where(RunEventRow.run_id == run_id)
    )
    next_seq = current_max or 0
    keys = {durable_identity(event)[1] for _, event in indexed_events}
    existing_rows = await session.execute(
        select(RunEventRow.dedupe_key, RunEventRow.seq).where(
            RunEventRow.run_id == run_id, RunEventRow.dedupe_key.in_(keys)
        )
    )
    known: dict[str, int] = {row.dedupe_key: row.seq for row in existing_rows}
    seqs: dict[int, int] = {}
    rows: list[dict[str, object]] = []
    inserted: list[EventEnvelope] = []
    for index, event in indexed_events:
        key = durable_identity(event)[1]
        existing = known.get(key)
        if existing is not None:
            seqs[index] = existing
            continue
        next_seq += 1
        known[key] = next_seq
        seqs[index] = next_seq
        rows.append(
            {
                "run_id": run_id,
                "seq": next_seq,
                "type": event.type,
                "ts": event.occurred_at,
                "payload": event.payload,
                "dedupe_key": key,
            }
        )
        inserted.append(event_envelope(next_seq, event))
    if rows:
        result = await session.execute(
            insert(RunEventRow)
            .values(rows)
            .on_conflict_do_nothing(index_elements=["run_id", "dedupe_key"])
            .returning(RunEventRow.seq)
        )
        if len(result.all()) != len(rows):
            raise RuntimeError(f"run {run_id}: concurrent writer broke the seq sequence")
        await session.execute(
            update(RunRow).where(RunRow.id == run_id).values(event_head_seq=next_seq)
        )
    return RunAppend(seqs=seqs, inserted=inserted)


async def append_events(
    session_factory: SessionFactory, hub: Hub, events: Sequence[IngestEvent]
) -> IngestEventResult:
    seqs: list[int | None] = [None] * len(events)
    durable_by_run: dict[UUID, list[tuple[int, IngestEvent]]] = defaultdict(list)
    ephemeral: list[IngestEvent] = []
    for index, event in enumerate(events):
        if event.ephemeral:
            ephemeral.append(event)
        else:
            durable_by_run[durable_identity(event)[0]].append((index, event))
    inserted_count = 0
    async with hub.run_locks(durable_by_run):
        if durable_by_run:
            appended: dict[UUID, RunAppend] = {}
            async with session_factory() as session:
                for run_id in sorted(durable_by_run):
                    appended[run_id] = await append_to_run(session, run_id, durable_by_run[run_id])
                await session.commit()
            for run_id in sorted(appended):
                for index, seq in appended[run_id].seqs.items():
                    seqs[index] = seq
                for envelope in appended[run_id].inserted:
                    hub.publish_persisted(envelope)
                inserted_count += len(appended[run_id].inserted)
    for event in ephemeral:
        hub.publish_ephemeral(event_envelope(None, event))
    durable_total = sum(len(items) for items in durable_by_run.values())
    return IngestEventResult(
        accepted=inserted_count + len(ephemeral),
        deduplicated=durable_total - inserted_count,
        seqs=seqs,
    )
