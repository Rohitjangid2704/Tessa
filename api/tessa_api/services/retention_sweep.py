import asyncio
import time
from collections.abc import Callable, Sequence
from contextlib import aclosing
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import Select, delete, func, null, select, update

from tessa_api.db.models import RunEventRow, RunRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.storage import StoredObject
from tessa_api.services.retention_pins import (
    ARTIFACTS_PREFIX,
    is_pinned,
    parse_artifact_key,
)
from tessa_api.services.run_guard import ACTIVE_RUN_STATUSES
from tessa_api.services.storage import Storage, StorageKey

STEP_BATCH_SIZE = 10_000
EVENT_BATCH_SIZE = 10_000
ARTIFACT_FLUSH_SIZE = 500
ARTIFACT_DELETE_CONCURRENCY = 16
PROGRESS_EVERY_SCANNED = 1000


@dataclass(frozen=True, slots=True)
class ExpiredObject:
    key: StorageKey
    is_artifact: bool


@dataclass(frozen=True, slots=True)
class ArtifactSlice:
    deleted: int
    scanned: int
    last_key: StorageKey | None
    finished: bool


def active_run_ids() -> Select[UUID]:
    return select(RunRow.id).where(RunRow.status.in_(ACTIVE_RUN_STATUSES))


async def purge_step_payload_batch(
    session_factory: SessionFactory, before: datetime, limit: int = STEP_BATCH_SIZE
) -> int:
    eligible = (
        select(StepRow.id)
        .where(
            StepRow.finished_at < before,
            StepRow.payload_purged_at.is_(None),
            StepRow.run_id.not_in(active_run_ids()),
        )
        .order_by(StepRow.finished_at)
        .limit(limit)
    )
    statement = (
        update(StepRow)
        .where(StepRow.id.in_(eligible))
        .values(request=null(), response=null(), evidence=null(), payload_purged_at=func.now())
        .returning(StepRow.id)
        .execution_options(synchronize_session=False)
    )
    async with session_factory() as session:
        purged = len((await session.execute(statement)).all())
        await session.commit()
    return purged


async def purge_run_event_batch(
    session_factory: SessionFactory, before: datetime, limit: int = EVENT_BATCH_SIZE
) -> int:
    eligible = (
        select(RunEventRow.id)
        .where(RunEventRow.ts < before, RunEventRow.run_id.not_in(active_run_ids()))
        .order_by(RunEventRow.ts)
        .limit(limit)
    )
    statement = (
        delete(RunEventRow)
        .where(RunEventRow.id.in_(eligible))
        .returning(RunEventRow.id)
        .execution_options(synchronize_session=False)
    )
    async with session_factory() as session:
        removed = len((await session.execute(statement)).all())
        await session.commit()
    return removed


def is_expired(stored: StoredObject, before: datetime) -> bool:
    return stored.modified_at is not None and stored.modified_at < before


def expired_object_of(
    stored: StoredObject, before: datetime, pinned: frozenset[UUID]
) -> ExpiredObject | None:
    if not is_expired(stored, before):
        return None
    item = parse_artifact_key(stored.key)
    if item is None or is_pinned(item.artifact_id, pinned):
        return None
    return ExpiredObject(key=StorageKey(stored.key), is_artifact=not item.is_metadata)


async def delete_all(storage: Storage, keys: Sequence[StorageKey]) -> None:
    gate = asyncio.Semaphore(ARTIFACT_DELETE_CONCURRENCY)

    async def delete_one(key: StorageKey) -> None:
        async with gate:
            await storage.delete(key)

    outcomes = await asyncio.gather(*(delete_one(key) for key in keys), return_exceptions=True)
    for outcome in outcomes:
        if isinstance(outcome, BaseException):
            raise outcome


async def purge_artifact_slice(
    storage: Storage,
    pinned: frozenset[UUID],
    before: datetime,
    after: StorageKey | None,
    max_scanned: int,
    max_seconds: float,
    on_progress: Callable[[], None],
) -> ArtifactSlice:
    started = time.monotonic()
    expired: list[StorageKey] = []
    deleted = 0
    scanned = 0
    last_key = after
    finished = True
    async with aclosing(storage.list_prefix(ARTIFACTS_PREFIX, after)) as listing:
        async for stored in listing:
            scanned += 1
            last_key = StorageKey(stored.key)
            found = expired_object_of(stored, before, pinned)
            if found is not None:
                expired.append(found.key)
                deleted += 1 if found.is_artifact else 0
            if len(expired) >= ARTIFACT_FLUSH_SIZE:
                await delete_all(storage, expired)
                expired.clear()
            if scanned % PROGRESS_EVERY_SCANNED == 0:
                on_progress()
            if scanned >= max_scanned or time.monotonic() - started >= max_seconds:
                finished = False
                break
    await delete_all(storage, expired)
    return ArtifactSlice(deleted=deleted, scanned=scanned, last_key=last_key, finished=finished)
