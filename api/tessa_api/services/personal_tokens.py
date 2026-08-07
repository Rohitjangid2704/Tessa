import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.auth.personal_tokens import hash_token, mint_token
from tessa_api.db.models import PersonalTokenRow, User
from tessa_api.errors import ApiError, not_found, unauthenticated
from tessa_api.ids import new_id
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import AuditAction, AuditSubjectType
from tessa_api.schemas.personal_tokens import (
    PersonalToken,
    PersonalTokenCreate,
    PersonalTokenCreated,
    PersonalTokenList,
    PersonalTokenState,
)
from tessa_api.services.audit import record_audit
from tessa_api.settings import Settings

MAX_LIVE_TOKENS_PER_USER = 10
LAST_USED_RESOLUTION = timedelta(seconds=60)
LISTED_TOKENS_LIMIT = 200


@dataclass(frozen=True, slots=True)
class AuthenticatedToken:
    token: PersonalTokenRow
    user: User


def token_state(row: PersonalTokenRow, now: datetime) -> PersonalTokenState:
    if row.revoked_at is not None:
        return "revoked"
    if row.expires_at <= now:
        return "expired"
    return "active"


def to_personal_token(row: PersonalTokenRow, now: datetime) -> PersonalToken:
    return PersonalToken(
        id=row.id,
        user_id=row.user_id,
        name=row.name,
        prefix=row.prefix,
        created_at=row.created_at,
        expires_at=row.expires_at,
        last_used_at=row.last_used_at,
        revoked_at=row.revoked_at,
        state=token_state(row, now),
    )


async def authenticate_personal_token(
    session: AsyncSession, secret: str, touch: bool = True
) -> AuthenticatedToken:
    row = await session.scalar(
        select(PersonalTokenRow).where(PersonalTokenRow.token_hash == hash_token(secret))
    )
    if row is None:
        raise unauthenticated("Invalid token")
    now = datetime.now(UTC)
    if row.revoked_at is not None:
        raise unauthenticated("The token was revoked", code="token_revoked")
    if row.expires_at <= now:
        raise unauthenticated("The token expired", code="token_expired")
    user = await session.get(User, row.user_id)
    if user is None or not user.is_active:
        raise unauthenticated("Unknown or inactive user")
    if touch and (row.last_used_at is None or now - row.last_used_at >= LAST_USED_RESOLUTION):
        await session.execute(
            update(PersonalTokenRow).where(PersonalTokenRow.id == row.id).values(last_used_at=now)
        )
        await session.commit()
    return AuthenticatedToken(token=row, user=user)


def expiry_too_long(maximum: int) -> ApiError:
    detail = ErrorDetail(
        loc=["body", "expires_in_days"],
        code="less_than_equal",
        message=f"Input should be less than or equal to {maximum}",
    )
    return ApiError(422, "validation_failed", "Request validation failed", [detail])


def token_limit_reached() -> ApiError:
    return ApiError(
        409,
        "token_limit",
        f"A user can hold at most {MAX_LIVE_TOKENS_PER_USER} live personal tokens; revoke one "
        "first",
    )


async def count_live_tokens(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> int:
    counted = await session.scalar(
        select(func.count())
        .select_from(PersonalTokenRow)
        .where(
            PersonalTokenRow.user_id == user_id,
            PersonalTokenRow.revoked_at.is_(None),
            PersonalTokenRow.expires_at > now,
        )
    )
    return int(counted or 0)


async def create_token(
    session: AsyncSession, settings: Settings, user: User, body: PersonalTokenCreate
) -> PersonalTokenCreated:
    maximum = settings.personal_token_max_days
    days = body.expires_in_days if body.expires_in_days is not None else maximum
    if days > maximum:
        raise expiry_too_long(maximum)
    user_id = user.id
    await session.execute(select(User.id).where(User.id == user_id).with_for_update())
    now = datetime.now(UTC)
    if await count_live_tokens(session, user_id, now) >= MAX_LIVE_TOKENS_PER_USER:
        raise token_limit_reached()
    minted = mint_token()
    row = PersonalTokenRow(
        id=new_id(),
        user_id=user_id,
        name=body.name,
        token_hash=minted.token_hash,
        prefix=minted.prefix,
        created_at=now,
        expires_at=now + timedelta(days=days),
    )
    session.add(row)
    await record_audit(
        session,
        user_id,
        AuditAction.token_created,
        AuditSubjectType.personal_token,
        row.id,
        {"name": row.name, "expires_at": row.expires_at.isoformat(), "days": days},
    )
    await session.commit()
    return PersonalTokenCreated(token=minted.secret, item=to_personal_token(row, now))


async def list_tokens(session: AsyncSession, user_id: uuid.UUID) -> PersonalTokenList:
    rows = await session.scalars(
        select(PersonalTokenRow)
        .where(PersonalTokenRow.user_id == user_id)
        .order_by(PersonalTokenRow.created_at.desc(), PersonalTokenRow.id.desc())
        .limit(LISTED_TOKENS_LIMIT)
    )
    now = datetime.now(UTC)
    return PersonalTokenList(items=[to_personal_token(row, now) for row in rows])


async def ensure_user_exists(session: AsyncSession, user_id: uuid.UUID) -> None:
    if await session.get(User, user_id) is None:
        raise not_found("User not found")


async def revoke_token(
    session: AsyncSession, actor_id: uuid.UUID, owner_id: uuid.UUID, token_id: uuid.UUID
) -> None:
    row = await session.get(PersonalTokenRow, token_id, with_for_update=True)
    if row is None or row.user_id != owner_id:
        raise not_found("Token not found")
    if row.revoked_at is None:
        row.revoked_at = datetime.now(UTC)
        await record_audit(
            session,
            actor_id,
            AuditAction.token_revoked,
            AuditSubjectType.personal_token,
            row.id,
            {"name": row.name, "owner_id": str(owner_id)},
        )
    await session.commit()
