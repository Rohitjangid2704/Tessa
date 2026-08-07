import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import ColumnElement, and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import AuditEventRow
from tessa_api.schemas.audit import AuditEvent, AuditEventPage
from tessa_api.schemas.enums import AuditSubjectType, AuditVia
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable

AUDIT_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(AuditEventRow.created_at, datetime)
}
AUDIT_ID_COLUMN = sortable(AuditEventRow.id, uuid.UUID)


@dataclass(frozen=True, slots=True)
class AuditFilters:
    actor_user_id: uuid.UUID | None = None
    via: AuditVia | None = None
    subject_type: AuditSubjectType | None = None
    subject_id: uuid.UUID | None = None
    agent_session_id: uuid.UUID | None = None
    since: datetime | None = None


def to_audit_event(row: AuditEventRow) -> AuditEvent:
    return AuditEvent(
        id=row.id,
        actor_user_id=row.actor_user_id,
        action=row.action,
        subject_type=row.subject_type,
        subject_id=row.subject_id,
        detail=row.detail,
        created_at=row.created_at,
        via=row.via,
        agent_session_id=row.agent_session_id,
    )


def filter_conditions(filters: AuditFilters) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if filters.actor_user_id is not None:
        conditions.append(AuditEventRow.actor_user_id == filters.actor_user_id)
    if filters.via is not None:
        conditions.append(AuditEventRow.via == filters.via)
    if filters.subject_type is not None:
        conditions.append(AuditEventRow.subject_type == filters.subject_type)
    if filters.subject_id is not None:
        conditions.append(AuditEventRow.subject_id == filters.subject_id)
    if filters.agent_session_id is not None:
        conditions.append(AuditEventRow.agent_session_id == filters.agent_session_id)
    if filters.since is not None:
        conditions.append(AuditEventRow.created_at >= filters.since)
    return conditions


async def list_audit_events(
    session: AsyncSession, query: PageQuery, filters: AuditFilters
) -> AuditEventPage:
    statement = select(AuditEventRow)
    conditions = filter_conditions(filters)
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(session, statement, AUDIT_SORT_COLUMNS, AUDIT_ID_COLUMN, query)
    return AuditEventPage(
        items=[to_audit_event(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )
