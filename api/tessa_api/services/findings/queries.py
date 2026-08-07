import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pydantic import JsonValue
from sqlalchemy import ColumnElement, and_, case, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import ExplanationRow, FindingOccurrenceRow, FindingRow
from tessa_api.errors import not_found
from tessa_api.schemas.enums import FindingClass, FindingStatus, Severity
from tessa_api.schemas.explanations import Explanation, ExplanationStructured
from tessa_api.schemas.findings import (
    Finding,
    FindingOccurrence,
    FindingOccurrencePage,
    FindingPage,
    FindingSummary,
)
from tessa_api.services.findings.severity import SEVERITY_RANK
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.scenario_library import SEARCH_ESCAPE, escape_like

SEVERITY_RANK_EXPRESSION = case(
    *[(FindingRow.severity == severity, rank) for severity, rank in SEVERITY_RANK.items()],
    else_=0,
)
FINDING_SORT_COLUMNS: Mapping[str, SortableColumn] = {
    "last_seen_at": sortable(FindingRow.last_seen_at, datetime),
    "first_seen_at": sortable(FindingRow.first_seen_at, datetime),
    "occurrence_count": sortable(FindingRow.occurrence_count, int),
    "severity": sortable(SEVERITY_RANK_EXPRESSION, int),
}
FINDING_ID_COLUMN = sortable(FindingRow.id, uuid.UUID)
OCCURRENCE_SORT_COLUMNS: Mapping[str, SortableColumn] = {
    "seen_at": sortable(FindingOccurrenceRow.seen_at, datetime)
}
OCCURRENCE_ID_COLUMN = sortable(FindingOccurrenceRow.id, uuid.UUID)
EXPECTED_KEY = "expected"
ACTUAL_KEY = "actual"


@dataclass(frozen=True, slots=True)
class FindingFilters:
    target_id: uuid.UUID | None = None
    statuses: Sequence[FindingStatus] = ()
    severities: Sequence[Severity] = ()
    classes: Sequence[FindingClass] = ()
    invariant_ids: Sequence[str] = ()
    run_id: uuid.UUID | None = None
    scenario_id: uuid.UUID | None = None
    fingerprint: str | None = None
    query: str | None = None


def finding_conditions(filters: FindingFilters) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if filters.target_id is not None:
        conditions.append(FindingRow.target_id == filters.target_id)
    if filters.statuses:
        conditions.append(FindingRow.status.in_(list(filters.statuses)))
    if filters.severities:
        conditions.append(FindingRow.severity.in_(list(filters.severities)))
    if filters.classes:
        conditions.append(FindingRow.class_.in_(list(filters.classes)))
    if filters.invariant_ids:
        conditions.append(FindingRow.invariant_id.in_(list(filters.invariant_ids)))
    if filters.run_id is not None:
        conditions.append(
            exists().where(
                FindingOccurrenceRow.finding_id == FindingRow.id,
                FindingOccurrenceRow.run_id == filters.run_id,
            )
        )
    if filters.scenario_id is not None:
        conditions.append(
            (FindingRow.scenario_id == filters.scenario_id)
            | (FindingRow.promoted_scenario_id == filters.scenario_id)
        )
    if filters.fingerprint:
        conditions.append(FindingRow.fingerprint == filters.fingerprint)
    if filters.query:
        pattern = f"%{escape_like(filters.query.strip())}%"
        conditions.append(FindingRow.title.ilike(pattern, escape=SEARCH_ESCAPE))
    return conditions


def to_summary(row: FindingRow) -> FindingSummary:
    return FindingSummary(
        id=row.id,
        target_id=row.target_id,
        fingerprint=row.fingerprint,
        title=row.title,
        class_=row.class_,
        severity=row.severity,
        status=row.status,
        invariant_id=row.invariant_id,
        scenario_id=row.scenario_id,
        first_seen_at=row.first_seen_at,
        last_seen_at=row.last_seen_at,
        occurrence_count=row.occurrence_count,
        ticket_url=row.ticket_url,
        known_gap_reason=row.known_gap_reason,
        promoted_scenario_id=row.promoted_scenario_id,
    )


def to_explanation(row: ExplanationRow) -> Explanation:
    return Explanation(
        id=row.id,
        finding_id=row.finding_id,
        text=row.text,
        source=row.source,
        created_by=row.created_by,
        created_at=row.created_at,
        structured=(
            ExplanationStructured.model_validate(row.structured)
            if row.structured is not None
            else None
        ),
    )


def to_occurrence(row: FindingOccurrenceRow) -> FindingOccurrence:
    return FindingOccurrence(
        id=row.id,
        finding_id=row.finding_id,
        run_id=row.run_id,
        run_scenario_id=row.run_scenario_id,
        step_id=row.step_id,
        attempt=row.attempt,
        seen_at=row.seen_at,
        evidence=dict(row.evidence),
    )


def evidence_json(evidence: Mapping[str, Any] | None, key: str) -> JsonValue:
    if evidence is None:
        return None
    value = evidence.get(key)
    return value if isinstance(value, str | int | float | bool | list | dict) else None


async def get_finding_row(session: AsyncSession, finding_id: uuid.UUID) -> FindingRow:
    row = await session.get(FindingRow, finding_id)
    if row is None:
        raise not_found("Finding not found")
    return row


async def latest_evidence(session: AsyncSession, finding_id: uuid.UUID) -> dict[str, Any] | None:
    evidence = await session.scalar(
        select(FindingOccurrenceRow.evidence)
        .where(FindingOccurrenceRow.finding_id == finding_id)
        .order_by(FindingOccurrenceRow.seen_at.desc(), FindingOccurrenceRow.id.desc())
        .limit(1)
    )
    return None if evidence is None else dict(evidence)


async def latest_explanation(session: AsyncSession, finding_id: uuid.UUID) -> Explanation | None:
    row = await session.scalar(
        select(ExplanationRow)
        .where(ExplanationRow.finding_id == finding_id)
        .order_by(ExplanationRow.created_at.desc(), ExplanationRow.id.desc())
        .limit(1)
    )
    return None if row is None else to_explanation(row)


async def to_finding(session: AsyncSession, row: FindingRow) -> Finding:
    evidence = await latest_evidence(session, row.id)
    return Finding(
        **to_summary(row).model_dump(),
        first_seen_run_id=row.first_seen_run_id,
        last_seen_run_id=row.last_seen_run_id,
        latest_explanation=await latest_explanation(session, row.id),
        expected=evidence_json(evidence, EXPECTED_KEY),
        actual=evidence_json(evidence, ACTUAL_KEY),
    )


async def read_finding(session: AsyncSession, finding_id: uuid.UUID) -> Finding:
    return await to_finding(session, await get_finding_row(session, finding_id))


async def list_findings(
    session: AsyncSession, query: PageQuery, filters: FindingFilters
) -> FindingPage:
    statement = select(FindingRow)
    conditions = finding_conditions(filters)
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(session, statement, FINDING_SORT_COLUMNS, FINDING_ID_COLUMN, query)
    return FindingPage(
        items=[to_summary(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def list_occurrences(
    session: AsyncSession, finding_id: uuid.UUID, query: PageQuery
) -> FindingOccurrencePage:
    await get_finding_row(session, finding_id)
    statement = select(FindingOccurrenceRow).where(FindingOccurrenceRow.finding_id == finding_id)
    page = await paginate(session, statement, OCCURRENCE_SORT_COLUMNS, OCCURRENCE_ID_COLUMN, query)
    return FindingOccurrencePage(
        items=[to_occurrence(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )
