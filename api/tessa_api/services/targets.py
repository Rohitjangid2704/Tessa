import re
import unicodedata
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Self

from sqlalchemy import ColumnElement, and_, or_, select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.db.models import User as UserRow
from tessa_api.errors import ApiError, forbidden, not_found
from tessa_api.schemas import targets as target_schemas
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import AppKind, AuditAction, AuditSubjectType, TargetTier, UserRole
from tessa_api.services.audit import record_audit
from tessa_api.services.health_checks import overall_status
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable

SLUG_MAX_LENGTH = 60
SLUG_FALLBACK = "target"
SLUG_ATTEMPTS = 5

TARGET_SORT_COLUMNS: dict[str, SortableColumn] = {
    "name": sortable(TargetRow.name, str),
    "created_at": sortable(TargetRow.created_at, datetime),
}
TARGET_ID_COLUMN = sortable(TargetRow.id, uuid.UUID)


def slugify(name: str, fallback: str = SLUG_FALLBACK) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:SLUG_MAX_LENGTH].strip("-")
    return slug or fallback


async def free_slug(session: AsyncSession, base: str) -> str:
    taken = set(
        (await session.scalars(select(TargetRow.slug).where(TargetRow.slug.like(f"{base}%")))).all()
    )
    if base not in taken:
        return base
    suffix = 2
    while f"{base}-{suffix}" in taken:
        suffix += 1
    return f"{base}-{suffix}"


def latest_bundle_subquery() -> Any:
    return (
        select(
            BundleRow.target_id.label("target_id"),
            BundleRow.id.label("bundle_id"),
            BundleRow.version.label("version"),
            BundleRow.completeness["score"].as_integer().label("score"),
        )
        .ext(distinct_on(BundleRow.target_id))
        .order_by(BundleRow.target_id, BundleRow.version.desc())
        .subquery("latest_bundle")
    )


def to_target(target: TargetRow, latest_bundle_id: uuid.UUID | None) -> target_schemas.Target:
    return target_schemas.Target(
        id=target.id,
        name=target.name,
        slug=target.slug,
        app_kind=target.app_kind,
        tier=target.tier,
        allow_production=target.allow_production,
        target_token=target.target_token,
        hints=target.hints,
        latest_bundle_id=latest_bundle_id,
        created_at=target.created_at,
        archived_at=target.archived_at,
    )


async def latest_bundle_id(session: AsyncSession, target_id: uuid.UUID) -> uuid.UUID | None:
    return await session.scalar(
        select(BundleRow.id)
        .where(BundleRow.target_id == target_id)
        .order_by(BundleRow.version.desc())
        .limit(1)
    )


async def get_target(session: AsyncSession, target_id: uuid.UUID) -> TargetRow:
    target = await session.get(TargetRow, target_id)
    if target is None:
        raise not_found("Target not found")
    return target


async def get_active_target(session: AsyncSession, target_id: uuid.UUID) -> TargetRow:
    target = await get_target(session, target_id)
    if target.archived_at is not None:
        raise ApiError(409, "conflict", "The target is archived")
    return target


async def read_target(session: AsyncSession, target_id: uuid.UUID) -> target_schemas.Target:
    target = await get_target(session, target_id)
    return to_target(target, await latest_bundle_id(session, target.id))


async def list_targets(
    session: AsyncSession,
    query: PageQuery,
    text: str | None,
    app_kinds: Sequence[AppKind] | None,
    tiers: Sequence[TargetTier] | None,
    include_archived: bool,
) -> target_schemas.TargetPage:
    latest = latest_bundle_subquery()
    statement = select(TargetRow, latest.c.version, latest.c.score).outerjoin(
        latest, latest.c.target_id == TargetRow.id
    )
    conditions: list[ColumnElement[bool]] = []
    if not include_archived:
        conditions.append(TargetRow.archived_at.is_(None))
    if text:
        conditions.append(
            or_(
                TargetRow.name.icontains(text, autoescape=True),
                TargetRow.slug.icontains(text, autoescape=True),
            )
        )
    if app_kinds:
        conditions.append(TargetRow.app_kind.in_(list(app_kinds)))
    if tiers:
        conditions.append(TargetRow.tier.in_(list(tiers)))
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(session, statement, TARGET_SORT_COLUMNS, TARGET_ID_COLUMN, query)
    items = [
        target_schemas.TargetSummary(
            id=row[0].id,
            name=row[0].name,
            slug=row[0].slug,
            app_kind=row[0].app_kind,
            tier=row[0].tier,
            latest_bundle_version=row[1],
            completeness_score=row[2],
            health=overall_status(row[0].health_report),
            created_at=row[0].created_at,
            archived_at=row[0].archived_at,
        )
        for row in page.rows
    ]
    return target_schemas.TargetPage(items=items, next_cursor=page.next_cursor, total=page.total)


def require_admin_for_production(user: UserRow, message: str) -> None:
    if user.role is not UserRole.admin:
        raise forbidden(message, code="role_required")


async def create_target(
    session: AsyncSession, user: UserRow, body: target_schemas.TargetCreate
) -> target_schemas.Target:
    tier = body.tier or TargetTier.qa
    if tier is TargetTier.production:
        require_admin_for_production(user, "Only an admin can create a production target")
    base = slugify(body.name)
    user_id = user.id
    for _ in range(SLUG_ATTEMPTS):
        target = TargetRow(
            name=body.name,
            slug=await free_slug(session, base),
            app_kind=body.app_kind,
            tier=tier,
            hints=body.hints or {},
            created_by=user_id,
        )
        session.add(target)
        try:
            await session.flush()
        except IntegrityError:
            await session.rollback()
            continue
        await session.commit()
        return to_target(target, None)
    raise ApiError(409, "conflict", "Could not allocate a unique slug for this name")


def null_not_allowed(field_name: str) -> ApiError:
    detail = ErrorDetail(
        loc=["body", field_name], code="null_not_allowed", message="This field cannot be null"
    )
    return ApiError(422, "validation_failed", "Request validation failed", [detail])


@dataclass(frozen=True, slots=True)
class AdminFields:
    allow_production: bool

    @classmethod
    def of(cls, target: TargetRow) -> Self:
        return cls(target.allow_production)


def validate_update(user: UserRow, target: TargetRow, body: target_schemas.TargetUpdate) -> None:
    changed = body.model_fields_set
    for field_name in ("name", "app_kind", "tier", "allow_production", "hints"):
        if field_name in changed and getattr(body, field_name) is None:
            raise null_not_allowed(field_name)
    if "allow_production" in changed and body.allow_production != target.allow_production:
        require_admin_for_production(user, "Only an admin can change allow_production")
    tier_changes = "tier" in changed and body.tier != target.tier
    if tier_changes and TargetTier.production in {body.tier, target.tier}:
        require_admin_for_production(user, "Only an admin can change a production tier")


async def audit_admin_field_changes(
    session: AsyncSession, actor_id: uuid.UUID, target: TargetRow, before: AdminFields
) -> None:
    after = AdminFields.of(target)
    if after.allow_production != before.allow_production:
        await record_audit(
            session,
            actor_id,
            AuditAction.allow_production_changed,
            AuditSubjectType.target,
            target.id,
            {
                "target_name": target.name,
                "from": before.allow_production,
                "to": after.allow_production,
            },
        )


async def update_target(
    session: AsyncSession,
    user: UserRow,
    target_id: uuid.UUID,
    body: target_schemas.TargetUpdate,
) -> target_schemas.Target:
    target = await get_active_target(session, target_id)
    validate_update(user, target, body)
    actor_id = user.id
    before = AdminFields.of(target)
    changed = body.model_fields_set
    if "name" in changed and body.name is not None:
        target.name = body.name
    if "app_kind" in changed and body.app_kind is not None:
        target.app_kind = body.app_kind
    if "tier" in changed and body.tier is not None:
        target.tier = body.tier
    if "allow_production" in changed and body.allow_production is not None:
        target.allow_production = body.allow_production
    if "hints" in changed and body.hints is not None:
        target.hints = body.hints
    await audit_admin_field_changes(session, actor_id, target, before)
    await session.commit()
    return to_target(target, await latest_bundle_id(session, target.id))


async def archive_target(session: AsyncSession, target_id: uuid.UUID) -> None:
    target = await get_target(session, target_id)
    if target.archived_at is None:
        target.archived_at = datetime.now(UTC)
        await session.commit()
