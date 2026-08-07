import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import ColumnElement, and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import InvariantResultRow
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import InvariantPack, VerdictStatus
from tessa_api.schemas.invariants import InvariantResult, InvariantResultPage
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.run_stats import get_run
from tessa_api.services.verdicts import INVARIANT_REASON_CODES, deciding_invariant_verdicts

INVARIANT_RESULT_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(InvariantResultRow.created_at, datetime),
    "invariant_id": sortable(InvariantResultRow.invariant_id, str),
    "status": sortable(InvariantResultRow.status, str),
}
INVARIANT_RESULT_ID_COLUMN = sortable(InvariantResultRow.id, uuid.UUID)


@dataclass(frozen=True)
class InvariantResultFilters:
    statuses: Sequence[VerdictStatus] = field(default_factory=tuple)
    invariant_ids: Sequence[str] = field(default_factory=tuple)
    packs: Sequence[InvariantPack] = field(default_factory=tuple)


def invariant_result_conditions(
    run_id: uuid.UUID, filters: InvariantResultFilters
) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = [InvariantResultRow.run_id == run_id]
    if filters.statuses:
        conditions.append(InvariantResultRow.status.in_(list(filters.statuses)))
    if filters.invariant_ids:
        conditions.append(InvariantResultRow.invariant_id.in_(list(filters.invariant_ids)))
    if filters.packs:
        conditions.append(InvariantResultRow.pack.in_(list(filters.packs)))
    return conditions


async def attempt_invariant_verdicts(
    session: AsyncSession, run_scenario_id: uuid.UUID, attempt: int
) -> list[Verdict]:
    rows = await session.scalars(
        select(InvariantResultRow).where(
            InvariantResultRow.run_scenario_id == run_scenario_id,
            InvariantResultRow.attempt == attempt,
            InvariantResultRow.status.in_(list(INVARIANT_REASON_CODES)),
        )
    )
    return deciding_invariant_verdicts(
        InvariantResult.model_validate(row, from_attributes=True) for row in rows
    )


async def list_run_invariants(
    session: AsyncSession, run_id: uuid.UUID, query: PageQuery, filters: InvariantResultFilters
) -> InvariantResultPage:
    await get_run(session, run_id)
    statement = select(InvariantResultRow).where(
        and_(*invariant_result_conditions(run_id, filters))
    )
    page = await paginate(
        session, statement, INVARIANT_RESULT_SORT_COLUMNS, INVARIANT_RESULT_ID_COLUMN, query
    )
    return InvariantResultPage(
        items=[InvariantResult.model_validate(row[0], from_attributes=True) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )
