import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, ScalarResult, and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BrowserSessionRow,
    FindingOccurrenceRow,
    FindingRow,
    RunRow,
    StepRow,
)
from tessa_api.services.artifact_store import ARTIFACTS_DIRECTORY_NAME, SHARD_HEX_DIGITS
from tessa_api.services.artifacts import META_SUFFIX
from tessa_api.services.run_guard import ACTIVE_RUN_STATUSES
from tessa_api.services.run_stats import OPEN_FINDING_STATUSES
from tessa_api.services.storage import StorageKey, storage_key

ARTIFACTS_PREFIX: StorageKey = storage_key(ARTIFACTS_DIRECTORY_NAME)
ARTIFACT_KEY_PATTERN = re.compile(
    rf"^{re.escape(ARTIFACTS_DIRECTORY_NAME)}/[0-9a-f]{{{SHARD_HEX_DIGITS}}}/"
    rf"(?P<hex>[0-9a-f]{{32}})(?P<meta>{re.escape(META_SUFFIX)})?$"
)
PINNING_STATUSES = sorted(OPEN_FINDING_STATUSES, key=lambda status: status.value)


@dataclass(frozen=True, slots=True)
class ArtifactObject:
    artifact_id: UUID
    is_metadata: bool


@dataclass(frozen=True, slots=True)
class PinInputs:
    finding_repros: Sequence[Mapping[str, Any] | None] = ()
    finding_step_artifacts: Sequence[Sequence[Mapping[str, Any]]] = ()
    finding_session_files: Sequence[Mapping[str, Any] | None] = ()
    active_step_artifacts: Sequence[Sequence[Mapping[str, Any]]] = ()
    active_session_files: Sequence[Mapping[str, Any] | None] = ()


def parse_artifact_key(key: str) -> ArtifactObject | None:
    matched = ARTIFACT_KEY_PATTERN.match(key)
    if matched is None:
        return None
    return ArtifactObject(
        artifact_id=UUID(hex=matched.group("hex")), is_metadata=matched.group("meta") is not None
    )


def artifact_id_of(document: object) -> UUID | None:
    if not isinstance(document, Mapping):
        return None
    try:
        return UUID(str(document.get("id")))
    except ValueError:
        return None


def artifact_ids_of(documents: Iterable[object]) -> set[UUID]:
    found = (artifact_id_of(document) for document in documents)
    return {artifact_id for artifact_id in found if artifact_id is not None}


def repro_documents(repro: Mapping[str, Any] | None) -> list[object]:
    screencast = None if repro is None else repro.get("screencast")
    return list(screencast) if isinstance(screencast, list) else []


def compute_pin_set(inputs: PinInputs) -> frozenset[UUID]:
    pinned: set[UUID] = set()
    for repro in inputs.finding_repros:
        pinned |= artifact_ids_of(repro_documents(repro))
    for artifacts in (*inputs.finding_step_artifacts, *inputs.active_step_artifacts):
        pinned |= artifact_ids_of(artifacts)
    pinned |= artifact_ids_of(inputs.finding_session_files)
    pinned |= artifact_ids_of(inputs.active_session_files)
    return frozenset(pinned)


def is_pinned(artifact_id: UUID, pinned: frozenset[UUID]) -> bool:
    return artifact_id in pinned


def occurrence_attempt_matches(session_attempt: Any) -> ColumnElement[bool]:
    return or_(
        FindingOccurrenceRow.attempt.is_(None), FindingOccurrenceRow.attempt == session_attempt
    )


async def load_finding_repros(session: AsyncSession) -> list[Mapping[str, Any] | None]:
    rows: ScalarResult[Mapping[str, Any] | None] = await session.scalars(
        select(FindingRow.repro).where(
            FindingRow.status.in_(PINNING_STATUSES), FindingRow.repro.is_not(None)
        )
    )
    return list(rows)


async def load_finding_step_artifacts(session: AsyncSession) -> list[list[dict[str, Any]]]:
    of_the_step: ScalarResult[list[dict[str, Any]]] = await session.scalars(
        select(StepRow.artifacts)
        .join(FindingOccurrenceRow, FindingOccurrenceRow.step_id == StepRow.id)
        .join(FindingRow, FindingRow.id == FindingOccurrenceRow.finding_id)
        .where(FindingRow.status.in_(PINNING_STATUSES))
    )
    of_the_attempt: ScalarResult[list[dict[str, Any]]] = await session.scalars(
        select(StepRow.artifacts)
        .join(
            FindingOccurrenceRow,
            and_(
                FindingOccurrenceRow.run_scenario_id == StepRow.run_scenario_id,
                occurrence_attempt_matches(StepRow.attempt),
            ),
        )
        .join(FindingRow, FindingRow.id == FindingOccurrenceRow.finding_id)
        .where(FindingRow.status.in_(PINNING_STATUSES), FindingOccurrenceRow.step_id.is_(None))
    )
    return [*of_the_step, *of_the_attempt]


async def load_finding_session_files(session: AsyncSession) -> list[Mapping[str, Any] | None]:
    rows = await session.execute(
        select(BrowserSessionRow.recording, BrowserSessionRow.trace)
        .join(
            FindingOccurrenceRow,
            and_(
                FindingOccurrenceRow.run_scenario_id == BrowserSessionRow.run_scenario_id,
                occurrence_attempt_matches(BrowserSessionRow.attempt),
            ),
        )
        .join(FindingRow, FindingRow.id == FindingOccurrenceRow.finding_id)
        .where(FindingRow.status.in_(PINNING_STATUSES))
    )
    return [document for row in rows for document in row]


async def load_active_step_artifacts(
    session: AsyncSession, artifacts_before: datetime
) -> list[list[dict[str, Any]]]:
    rows: ScalarResult[list[dict[str, Any]]] = await session.scalars(
        select(StepRow.artifacts).where(
            StepRow.run_id.in_(select(RunRow.id).where(RunRow.status.in_(ACTIVE_RUN_STATUSES))),
            StepRow.finished_at < artifacts_before,
        )
    )
    return list(rows)


async def load_active_session_files(session: AsyncSession) -> list[Mapping[str, Any] | None]:
    rows = await session.execute(
        select(BrowserSessionRow.recording, BrowserSessionRow.trace).where(
            BrowserSessionRow.run_id.in_(
                select(RunRow.id).where(RunRow.status.in_(ACTIVE_RUN_STATUSES))
            )
        )
    )
    return [document for row in rows for document in row]


async def load_pin_inputs(session: AsyncSession, artifacts_before: datetime) -> PinInputs:
    return PinInputs(
        finding_repros=await load_finding_repros(session),
        finding_step_artifacts=await load_finding_step_artifacts(session),
        finding_session_files=await load_finding_session_files(session),
        active_step_artifacts=await load_active_step_artifacts(session, artifacts_before),
        active_session_files=await load_active_session_files(session),
    )
