import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import ColumnElement, and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import NotificationRow
from tessa_api.errors import not_found
from tessa_api.ids import new_id
from tessa_api.schemas.enums import NotificationKind
from tessa_api.schemas.notifications import (
    Notification,
    NotificationDraft,
    NotificationPage,
)
from tessa_api.schemas.streams import IngestEvent, NotificationCreatedPayload
from tessa_api.services.dashboard_events import dashboard_invalidate_event
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import event_envelope

logger = logging.getLogger("tessa_api.notifications")

NOTIFICATION_CREATED = "notification.created"
NOTIFICATION_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(NotificationRow.created_at, datetime),
}
NOTIFICATION_ID_COLUMN = sortable(NotificationRow.id, uuid.UUID)


class NotificationEvents(Protocol):
    async def created(self, notification: Notification) -> None: ...


@dataclass(frozen=True, slots=True)
class NotificationWrite:
    notification: Notification
    created: bool


def to_notification(row: NotificationRow) -> Notification:
    return Notification(
        id=row.id,
        kind=row.kind,
        severity=row.severity,
        title=row.title,
        body=row.body,
        link=row.link,
        run_id=row.run_id,
        read_at=row.read_at,
        created_at=row.created_at,
    )


def notification_events(notification: Notification) -> list[IngestEvent]:
    occurred_at = datetime.now(UTC)
    created = NotificationCreatedPayload(
        notification_id=notification.id,
        kind=notification.kind,
        severity=notification.severity,
        title=notification.title,
        link=notification.link,
    )
    return [
        IngestEvent(
            type=NOTIFICATION_CREATED,
            payload=created.model_dump(mode="json"),
            occurred_at=occurred_at,
            ephemeral=True,
        ),
        dashboard_invalidate_event(),
    ]


class HubNotificationEvents:
    def __init__(self, hub: Hub) -> None:
        self.hub = hub

    async def created(self, notification: Notification) -> None:
        for event in notification_events(notification):
            self.hub.publish_ephemeral(event_envelope(None, event))


def visible_to(user_id: uuid.UUID) -> ColumnElement[bool]:
    return or_(NotificationRow.user_id == user_id, NotificationRow.user_id.is_(None))


def notification_conditions(
    user_id: uuid.UUID, unread: bool | None, kinds: Sequence[NotificationKind]
) -> list[ColumnElement[bool]]:
    conditions = [visible_to(user_id)]
    if unread is True:
        conditions.append(NotificationRow.read_at.is_(None))
    if unread is False:
        conditions.append(NotificationRow.read_at.is_not(None))
    if kinds:
        conditions.append(NotificationRow.kind.in_(list(kinds)))
    return conditions


async def list_notifications(
    session: AsyncSession,
    user_id: uuid.UUID,
    query: PageQuery,
    unread: bool | None,
    kinds: Sequence[NotificationKind],
) -> NotificationPage:
    statement = select(NotificationRow).where(
        and_(*notification_conditions(user_id, unread, kinds))
    )
    page = await paginate(
        session, statement, NOTIFICATION_SORT_COLUMNS, NOTIFICATION_ID_COLUMN, query
    )
    return NotificationPage(
        items=[to_notification(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def mark_read(
    session: AsyncSession, user_id: uuid.UUID, notification_id: uuid.UUID
) -> Notification:
    row = await session.scalar(
        select(NotificationRow)
        .where(NotificationRow.id == notification_id, visible_to(user_id))
        .with_for_update()
    )
    if row is None:
        raise not_found("Notification not found")
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
    await session.commit()
    return to_notification(row)


async def mark_all_read(session: AsyncSession, user_id: uuid.UUID) -> None:
    await session.execute(
        update(NotificationRow)
        .where(visible_to(user_id), NotificationRow.read_at.is_(None))
        .values(read_at=datetime.now(UTC))
    )
    await session.commit()


async def find_existing(
    session: AsyncSession, kind: NotificationKind, run_id: uuid.UUID | None
) -> NotificationRow | None:
    if run_id is None:
        return None
    return await session.scalar(
        select(NotificationRow).where(
            NotificationRow.kind == kind, NotificationRow.run_id == run_id
        )
    )


def new_notification_row(draft: NotificationDraft) -> NotificationRow:
    return NotificationRow(
        id=new_id(),
        user_id=draft.user_id,
        kind=draft.kind,
        severity=draft.severity,
        title=draft.title,
        body=draft.body,
        link=draft.link,
        run_id=draft.run_id,
        created_at=datetime.now(UTC),
    )


async def insert_unique(
    session: AsyncSession, draft: NotificationDraft
) -> tuple[NotificationRow, bool]:
    row = new_notification_row(draft)
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        existing = await find_existing(session, draft.kind, draft.run_id)
        if existing is None:
            raise
        return existing, False
    return row, True


async def announce(events: NotificationEvents | None, notification: Notification) -> None:
    if events is None:
        return
    try:
        await events.created(notification)
    except Exception:
        logger.exception(
            "notification_events_not_delivered", extra={"notification_id": str(notification.id)}
        )


async def create_notification_row(
    session: AsyncSession,
    draft: NotificationDraft,
    events: NotificationEvents | None = None,
) -> NotificationWrite:
    existing = await find_existing(session, draft.kind, draft.run_id)
    if existing is not None:
        return NotificationWrite(to_notification(existing), created=False)
    row, created = await insert_unique(session, draft)
    notification = to_notification(row)
    if not created:
        return NotificationWrite(notification, created=False)
    await session.commit()
    await announce(events, notification)
    return NotificationWrite(notification, created=True)
