import time
import uuid
from collections.abc import Callable

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import MutantRow, MutationRunRow
from tessa_api.schemas.enums import MutantStatus
from tessa_api.schemas.mutation import MutationOutcomeItem, MutationSummary
from tessa_api.services.mutation_scoring import LatestMutantRun, build_summary

SUMMARY_TTL_SECONDS = 60.0


class SummaryCache:
    def __init__(self, ttl_seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.ttl_seconds = ttl_seconds
        self.clock = clock
        self.generation = 0
        self.entries: dict[uuid.UUID | None, tuple[float, MutationSummary]] = {}

    def read(self, key: uuid.UUID | None) -> MutationSummary | None:
        found = self.entries.get(key)
        if found is None:
            return None
        stored_at, summary = found
        if self.clock() - stored_at >= self.ttl_seconds:
            del self.entries[key]
            return None
        return summary.model_copy(deep=True)

    def begin(self) -> int:
        return self.generation

    def store(self, key: uuid.UUID | None, summary: MutationSummary, generation: int) -> None:
        if generation != self.generation:
            return
        self.entries[key] = (self.clock(), summary.model_copy(deep=True))

    def clear(self) -> None:
        self.generation += 1
        self.entries.clear()


MUTATION_SUMMARY_CACHE = SummaryCache(SUMMARY_TTL_SECONDS)


def target_conditions(target_id: uuid.UUID | None) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = [MutantRow.status != MutantStatus.retired]
    if target_id is not None:
        conditions.append(MutantRow.target_id == target_id)
    return conditions


async def latest_scored_runs(
    session: AsyncSession, mutant_ids: list[uuid.UUID]
) -> dict[uuid.UUID, MutationRunRow]:
    rows = await session.scalars(
        select(MutationRunRow)
        .distinct(MutationRunRow.mutant_id)
        .where(
            MutationRunRow.mutant_id.in_(mutant_ids),
            func.jsonb_array_length(MutationRunRow.outcomes) > 0,
        )
        .order_by(MutationRunRow.mutant_id, MutationRunRow.started_at.desc())
    )
    return {row.mutant_id: row for row in rows}


async def load_latest_runs(
    session: AsyncSession, target_id: uuid.UUID | None
) -> list[LatestMutantRun]:
    mutants = list(
        await session.scalars(
            select(MutantRow).where(*target_conditions(target_id)).order_by(MutantRow.name)
        )
    )
    if not mutants:
        return []
    runs = await latest_scored_runs(session, [mutant.id for mutant in mutants])
    return [
        LatestMutantRun(
            mutant_id=mutant.id,
            name=mutant.name,
            last_outcome=mutant.last_outcome,
            outcomes=(
                [MutationOutcomeItem.model_validate(item) for item in runs[mutant.id].outcomes]
                if mutant.id in runs
                else []
            ),
        )
        for mutant in mutants
    ]


async def summarize_mutation(session: AsyncSession, target_id: uuid.UUID | None) -> MutationSummary:
    cached = MUTATION_SUMMARY_CACHE.read(target_id)
    if cached is not None:
        return cached
    generation = MUTATION_SUMMARY_CACHE.begin()
    summary = build_summary(await load_latest_runs(session, target_id))
    MUTATION_SUMMARY_CACHE.store(target_id, summary, generation)
    return summary
