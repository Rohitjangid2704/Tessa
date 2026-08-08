from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BrowserSessionRow, RunEventRow, RunRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import BrowserSessionStatus
from tessa_api.schemas.events import EventEnvelope
from tessa_api.schemas.streams import RunEvent

REPLAY_BATCH_SIZE = 500


@dataclass(frozen=True, slots=True)
class LogBounds:
    head_seq: int
    min_seq: int | None


async def read_log_bounds(session: AsyncSession, run_id: UUID) -> LogBounds:
    row = (
        await session.execute(
            select(func.max(RunEventRow.seq), func.min(RunEventRow.seq)).where(
                RunEventRow.run_id == run_id
            )
        )
    ).one()
    return LogBounds(head_seq=row[0] or 0, min_seq=row[1])


async def run_has_events(session: AsyncSession, run_id: UUID) -> bool:
    found = await session.scalar(
        select(RunEventRow.id).where(RunEventRow.run_id == run_id).limit(1)
    )
    return found is not None


async def run_row_exists(session: AsyncSession, run_id: UUID) -> bool:
    found = await session.scalar(select(RunRow.id).where(RunRow.id == run_id))
    return found is not None


async def run_is_known(session: AsyncSession, run_id: UUID) -> bool:
    return await run_row_exists(session, run_id) or await run_has_events(session, run_id)


async def read_active_browser_session_ids(session: AsyncSession, run_id: UUID) -> list[UUID]:
    result = await session.scalars(
        select(BrowserSessionRow.id)
        .where(
            BrowserSessionRow.run_id == run_id,
            BrowserSessionRow.status == BrowserSessionStatus.active,
        )
        .order_by(BrowserSessionRow.started_at, BrowserSessionRow.id)
    )
    return list(result.all())


async def find_active_browser_session_run(session: AsyncSession, session_id: UUID) -> UUID | None:
    return await session.scalar(
        select(BrowserSessionRow.run_id).where(
            BrowserSessionRow.id == session_id,
            BrowserSessionRow.status == BrowserSessionStatus.active,
        )
    )


async def read_events_page(
    session: AsyncSession,
    run_id: UUID,
    after_seq: int | None,
    before_seq: int | None,
    order: Literal["asc", "desc"],
    limit: int,
    types: Sequence[str] | None,
) -> tuple[list[RunEventRow], bool]:
    statement = select(RunEventRow).where(RunEventRow.run_id == run_id)
    if after_seq is not None:
        statement = statement.where(RunEventRow.seq > after_seq)
    if before_seq is not None:
        statement = statement.where(RunEventRow.seq < before_seq)
    if types:
        statement = statement.where(RunEventRow.type.in_(types))
    ordering = RunEventRow.seq.asc() if order == "asc" else RunEventRow.seq.desc()
    rows = list((await session.scalars(statement.order_by(ordering).limit(limit + 1))).all())
    return rows[:limit], len(rows) > limit


async def iter_replay_batches(
    session_factory: SessionFactory, run_id: UUID, after_seq: int, through_seq: int
) -> AsyncIterator[list[RunEventRow]]:
    cursor = after_seq
    while cursor < through_seq:
        async with session_factory() as session:
            result = await session.scalars(
                select(RunEventRow)
                .where(
                    RunEventRow.run_id == run_id,
                    RunEventRow.seq > cursor,
                    RunEventRow.seq <= through_seq,
                )
                .order_by(RunEventRow.seq)
                .limit(REPLAY_BATCH_SIZE)
            )
            rows = list(result.all())
        if not rows:
            return
        yield rows
        cursor = rows[-1].seq


def to_run_event(row: RunEventRow) -> RunEvent:
    return RunEvent(type=row.type, run_id=row.run_id, seq=row.seq, ts=row.ts, payload=row.payload)


def to_envelope(row: RunEventRow) -> EventEnvelope:
    return EventEnvelope(
        type=row.type, run_id=row.run_id, seq=row.seq, ts=row.ts, payload=row.payload
    )
