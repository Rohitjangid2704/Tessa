import math
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import FindingOccurrenceRow, FindingRow
from tessa_api.schemas.enums import FindingClass


@dataclass(frozen=True, slots=True)
class Neighbour:
    finding_id: uuid.UUID
    title: str
    signal: str | None
    similarity: float


async def exact_matches(
    session: AsyncSession, target_id: uuid.UUID, fingerprints: Sequence[str]
) -> dict[str, uuid.UUID]:
    if not fingerprints:
        return {}
    rows = await session.execute(
        select(FindingRow.fingerprint, FindingRow.id).where(
            FindingRow.target_id == target_id, FindingRow.fingerprint.in_(list(fingerprints))
        )
    )
    return dict(rows.tuples().all())


async def latest_signal(session: AsyncSession, finding_id: uuid.UUID) -> str | None:
    evidence = await session.scalar(
        select(FindingOccurrenceRow.evidence)
        .where(FindingOccurrenceRow.finding_id == finding_id)
        .order_by(FindingOccurrenceRow.seen_at.desc())
        .limit(1)
    )
    signal = None if evidence is None else evidence.get("signal")
    return signal if isinstance(signal, str) else None


async def nearest_neighbour(
    session: AsyncSession,
    target_id: uuid.UUID,
    finding_class: FindingClass,
    embedding: Sequence[float],
    min_similarity: float,
) -> Neighbour | None:
    distance = FindingRow.embedding.cosine_distance(list(embedding))
    row = (
        await session.execute(
            select(FindingRow.id, FindingRow.title, distance.label("distance"))
            .where(
                FindingRow.target_id == target_id,
                FindingRow.class_ == finding_class,
                FindingRow.embedding.is_not(None),
            )
            .order_by(distance)
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    similarity = 1.0 - float(row.distance)
    if not math.isfinite(similarity) or similarity < min_similarity:
        return None
    return Neighbour(
        finding_id=row.id,
        title=row.title,
        signal=await latest_signal(session, row.id),
        similarity=min(similarity, 1.0),
    )
