import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import ColumnElement, and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.auth.users import DuplicateEmailError, hash_password, insert_user
from tessa_api.db.models import User as UserRow
from tessa_api.errors import ApiError, not_found
from tessa_api.schemas import users as user_schemas
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import AuditAction, AuditSubjectType, UserRole
from tessa_api.services.audit import record_audit
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.targets import null_not_allowed

USER_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(UserRow.created_at, datetime),
    "email": sortable(UserRow.email, str),
    "name": sortable(UserRow.name, str),
}
USER_ID_COLUMN = sortable(UserRow.id, uuid.UUID)
NON_NULL_UPDATE_FIELDS = ("name", "role", "is_active")


def to_user(row: UserRow) -> user_schemas.User:
    return user_schemas.User(
        id=row.id,
        email=row.email,
        name=row.name,
        role=row.role,
        is_active=row.is_active,
        created_at=row.created_at,
        last_login_at=row.last_login_at,
    )


async def list_users(
    session: AsyncSession,
    query: PageQuery,
    text: str | None,
    roles: Sequence[UserRole] | None,
    is_active: bool | None,
) -> user_schemas.UserPage:
    conditions: list[ColumnElement[bool]] = []
    if text:
        conditions.append(
            or_(
                UserRow.email.icontains(text, autoescape=True),
                UserRow.name.icontains(text, autoescape=True),
            )
        )
    if roles:
        conditions.append(UserRow.role.in_(list(roles)))
    if is_active is not None:
        conditions.append(UserRow.is_active.is_(is_active))
    statement = select(UserRow)
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(session, statement, USER_SORT_COLUMNS, USER_ID_COLUMN, query)
    items = [to_user(row[0]) for row in page.rows]
    return user_schemas.UserPage(items=items, next_cursor=page.next_cursor, total=page.total)


def duplicate_email_error() -> ApiError:
    detail = ErrorDetail(
        loc=["body", "email"],
        code="duplicate_email",
        message="A user with this email already exists",
    )
    return ApiError(409, "conflict", "A user with this email already exists", [detail])


def safeguard_error(field_name: str, code: str, message: str) -> ApiError:
    detail = ErrorDetail(loc=["body", field_name], code=code, message=message)
    return ApiError(409, "conflict", message, [detail])


async def create_user_account(
    session: AsyncSession, actor: UserRow, body: user_schemas.UserCreate
) -> user_schemas.User:
    actor_id = actor.id
    password_hash = (
        None if body.password is None else await hash_password(body.password.get_secret_value())
    )
    try:
        row = await insert_user(session, body.email, body.name, password_hash, body.role)
    except DuplicateEmailError:
        raise duplicate_email_error() from None
    await record_audit(
        session,
        actor_id,
        AuditAction.user_created,
        AuditSubjectType.user,
        row.id,
        {
            "email": row.email,
            "name": row.name,
            "role": row.role.value,
            "sso_only": password_hash is None,
        },
    )
    await session.commit()
    return to_user(row)


async def lock_active_admins(session: AsyncSession) -> list[uuid.UUID]:
    rows = await session.scalars(
        select(UserRow.id)
        .where(UserRow.role == UserRole.admin, UserRow.is_active.is_(True))
        .order_by(UserRow.id)
        .with_for_update()
    )
    return list(rows.all())


async def load_user_for_update(session: AsyncSession, user_id: uuid.UUID) -> UserRow:
    row = await session.scalar(
        select(UserRow)
        .where(UserRow.id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise not_found("User not found")
    return row


def reject_null_fields(body: user_schemas.UserUpdate) -> None:
    for field_name in NON_NULL_UPDATE_FIELDS:
        if field_name in body.model_fields_set and getattr(body, field_name) is None:
            raise null_not_allowed(field_name)


def enforce_admin_safeguards(
    actor_id: uuid.UUID,
    row: UserRow,
    body: user_schemas.UserUpdate,
    active_admin_ids: Sequence[uuid.UUID],
) -> None:
    is_active_admin = row.role is UserRole.admin and row.is_active
    loses_admin = is_active_admin and body.role is not None and body.role is not UserRole.admin
    deactivates = is_active_admin and body.is_active is False
    if row.is_active and body.is_active is False and actor_id == row.id:
        raise safeguard_error(
            "is_active", "cannot_deactivate_self", "You cannot deactivate your own account"
        )
    if loses_admin and actor_id == row.id:
        raise safeguard_error("role", "cannot_demote_self", "You cannot demote your own account")
    if (loses_admin or deactivates) and not [i for i in active_admin_ids if i != row.id]:
        raise safeguard_error(
            "role" if loses_admin else "is_active",
            "last_admin",
            "The last active admin cannot be demoted or deactivated",
        )


async def apply_user_changes(
    session: AsyncSession, actor_id: uuid.UUID, row: UserRow, body: user_schemas.UserUpdate
) -> None:
    if body.name is not None:
        row.name = body.name
    if body.role is not None and body.role is not row.role:
        await record_audit(
            session,
            actor_id,
            AuditAction.user_role_changed,
            AuditSubjectType.user,
            row.id,
            {"email": row.email, "from": row.role.value, "to": body.role.value},
        )
        row.role = body.role
    if body.is_active is not None and body.is_active is not row.is_active:
        await record_audit(
            session,
            actor_id,
            AuditAction.user_active_changed,
            AuditSubjectType.user,
            row.id,
            {"email": row.email, "from": row.is_active, "to": body.is_active},
        )
        row.is_active = body.is_active


async def update_user_account(
    session: AsyncSession, actor: UserRow, user_id: uuid.UUID, body: user_schemas.UserUpdate
) -> user_schemas.User:
    reject_null_fields(body)
    actor_id = actor.id
    active_admin_ids = await lock_active_admins(session)
    row = await load_user_for_update(session, user_id)
    enforce_admin_safeguards(actor_id, row, body, active_admin_ids)
    await apply_user_changes(session, actor_id, row, body)
    await session.commit()
    return to_user(row)
