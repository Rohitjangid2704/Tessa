import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import AgentSessionRow, User
from tessa_api.errors import not_found
from tessa_api.ids import new_id
from tessa_api.schemas.agent_sessions import (
    AgentSession,
    AgentSessionCreate,
    AgentSessionPage,
    AgentSessionUpdate,
)
from tessa_api.schemas.streams import AgentSessionChangedPayload, IngestEvent
from tessa_api.services.grading_rules import redacted_text
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.targets import get_target
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import event_envelope

AGENT_SESSION_CHANGED = "agent_session.changed"
ACTIVE_WINDOW = timedelta(hours=12)

AGENT_SESSION_SORT_COLUMNS: dict[str, SortableColumn] = {
    "started_at": sortable(AgentSessionRow.started_at, datetime)
}
AGENT_SESSION_ID_COLUMN = sortable(AgentSessionRow.id, uuid.UUID)


def is_active(row: AgentSessionRow, now: datetime) -> bool:
    return row.ended_at is None and now - row.started_at < ACTIVE_WINDOW


def to_agent_session(row: AgentSessionRow, user_name: str, now: datetime) -> AgentSession:
    return AgentSession(
        id=row.id,
        user_id=row.user_id,
        user_name=user_name,
        target_id=row.target_id,
        claude_session_id=row.claude_session_id,
        cwd_label=row.cwd_label,
        plugin_version=row.plugin_version,
        started_at=row.started_at,
        ended_at=row.ended_at,
        summary=row.summary,
        write_count=row.write_count,
        active=is_active(row, now),
    )


def changed_event(row: AgentSessionRow, active: bool) -> IngestEvent:
    payload = AgentSessionChangedPayload(
        agent_session_id=row.id, user_id=row.user_id, target_id=row.target_id, active=active
    )
    return IngestEvent(
        type=AGENT_SESSION_CHANGED,
        payload=payload.model_dump(mode="json"),
        occurred_at=datetime.now(UTC),
        ephemeral=True,
    )


def publish_changed(hub: Hub, row: AgentSessionRow) -> None:
    hub.publish_ephemeral(
        event_envelope(None, changed_event(row, is_active(row, datetime.now(UTC))))
    )


async def agent_session_of(
    session: AsyncSession, user_id: uuid.UUID, header: str | None
) -> uuid.UUID | None:
    if header is None:
        return None
    try:
        candidate = uuid.UUID(header.strip())
    except ValueError:
        return None
    return await session.scalar(
        select(AgentSessionRow.id).where(
            AgentSessionRow.id == candidate, AgentSessionRow.user_id == user_id
        )
    )


async def find_open_session(
    session: AsyncSession, user_id: uuid.UUID, claude_session_id: str
) -> AgentSessionRow | None:
    return await session.scalar(
        select(AgentSessionRow)
        .where(
            AgentSessionRow.user_id == user_id,
            AgentSessionRow.claude_session_id == claude_session_id,
            AgentSessionRow.ended_at.is_(None),
        )
        .order_by(AgentSessionRow.started_at.desc())
        .limit(1)
    )


async def create_session(
    session: AsyncSession, user: User, body: AgentSessionCreate
) -> tuple[AgentSession, AgentSessionRow, bool]:
    user_id, user_name = user.id, user.name
    now = datetime.now(UTC)
    if body.target_id is not None:
        await get_target(session, body.target_id)
    existing = await find_open_session(session, user_id, body.claude_session_id)
    if existing is not None:
        existing.plugin_version = body.plugin_version
        if body.target_id is not None:
            existing.target_id = body.target_id
        await session.commit()
        return to_agent_session(existing, user_name, now), existing, False
    row = AgentSessionRow(
        id=new_id(),
        user_id=user_id,
        target_id=body.target_id,
        claude_session_id=body.claude_session_id,
        cwd_label=body.cwd_label,
        plugin_version=body.plugin_version,
        started_at=now,
        write_count=0,
    )
    session.add(row)
    await session.commit()
    return to_agent_session(row, user_name, now), row, True


def clamped_end_time(row: AgentSessionRow, ended_at: datetime, now: datetime) -> datetime:
    return max(row.started_at, min(ended_at, now))


async def update_session(
    session: AsyncSession, user: User, agent_session_id: uuid.UUID, body: AgentSessionUpdate
) -> tuple[AgentSession, AgentSessionRow]:
    user_id, user_name = user.id, user.name
    row = await session.get(AgentSessionRow, agent_session_id, with_for_update=True)
    if row is None or row.user_id != user_id:
        raise not_found("Agent session not found")
    now = datetime.now(UTC)
    if "target_id" in body.model_fields_set:
        if body.target_id is not None:
            await get_target(session, body.target_id)
        row.target_id = body.target_id
    if body.ended_at is not None and row.ended_at is None:
        row.ended_at = clamped_end_time(row, body.ended_at, now)
    if "summary" in body.model_fields_set:
        row.summary = redacted_text(body.summary) if body.summary is not None else None
    await session.commit()
    return to_agent_session(row, user_name, now), row


def filter_conditions(
    now: datetime, target_id: uuid.UUID | None, user_id: uuid.UUID | None, active: bool | None
) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if target_id is not None:
        conditions.append(AgentSessionRow.target_id == target_id)
    if user_id is not None:
        conditions.append(AgentSessionRow.user_id == user_id)
    if active is not None:
        open_now = and_(
            AgentSessionRow.ended_at.is_(None), AgentSessionRow.started_at > now - ACTIVE_WINDOW
        )
        conditions.append(open_now if active else ~open_now)
    return conditions


async def list_sessions(
    session: AsyncSession,
    query: PageQuery,
    target_id: uuid.UUID | None,
    user_id: uuid.UUID | None,
    active: bool | None,
) -> AgentSessionPage:
    now = datetime.now(UTC)
    statement = select(AgentSessionRow, User.name).join(User, User.id == AgentSessionRow.user_id)
    conditions = filter_conditions(now, target_id, user_id, active)
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(
        session, statement, AGENT_SESSION_SORT_COLUMNS, AGENT_SESSION_ID_COLUMN, query
    )
    return AgentSessionPage(
        items=[to_agent_session(row[0], row[1], now) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )
