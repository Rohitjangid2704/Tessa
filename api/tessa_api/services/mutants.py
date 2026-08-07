import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import ColumnElement, and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import MutantRow, MutationRunRow, RunRow, User
from tessa_api.errors import ApiError, not_found
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import MutantStatus
from tessa_api.schemas.mutants import (
    DeployedMarker,
    Mutant,
    MutantCreate,
    MutantPage,
    MutantUpdate,
)
from tessa_api.services.mutant_invariants import (
    ensure_invariants_known,
    load_invariant_vocabulary,
)
from tessa_api.services.mutation_summary import MUTATION_SUMMARY_CACHE
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.production_url import is_plain_http_address, matches_production_pattern
from tessa_api.services.run_guard import ACTIVE_RUN_STATUSES
from tessa_api.services.targets import get_active_target
from tessa_api.settings import Settings

MUTANT_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(MutantRow.created_at, datetime),
    "name": sortable(MutantRow.name, str),
}
MUTANT_ID_COLUMN = sortable(MutantRow.id, uuid.UUID)
DEFINITION_FIELDS = ("branch", "expected_catchers", "base_url", "deployed_marker")


def to_mutant(row: MutantRow) -> Mutant:
    return Mutant(
        id=row.id,
        target_id=row.target_id,
        name=row.name,
        branch=row.branch,
        description=row.description,
        expected_catchers=list(row.expected_catchers),
        base_url=row.base_url,
        deployed_marker=(
            None
            if row.deployed_marker is None
            else DeployedMarker.model_validate(row.deployed_marker)
        ),
        status=row.status,
        last_outcome=row.last_outcome,
        created_at=row.created_at,
    )


def marker_document(marker: DeployedMarker | None) -> dict[str, Any] | None:
    return None if marker is None else marker.model_dump(mode="json")


def duplicate_name_error(name: str) -> ApiError:
    return ApiError(
        409,
        "conflict",
        "A mutant with this name already exists for the target",
        [
            ErrorDetail(
                loc=["body", "name"],
                code="duplicate_name",
                message=f"The target already has a mutant named {name!r}",
            )
        ],
    )


def production_url_error(field_name: str) -> ApiError:
    return ApiError(
        422,
        "validation_failed",
        "Request validation failed",
        [
            ErrorDetail(
                loc=["body", field_name],
                code="production_url",
                message="The address matches a production URL pattern; a mutant never runs on "
                "production",
            )
        ],
    )


def base_url_invalid_error() -> ApiError:
    return ApiError(
        422,
        "validation_failed",
        "Request validation failed",
        [
            ErrorDetail(
                loc=["body", "base_url"],
                code="base_url_invalid",
                message="The base URL must be an http or https address without credentials, "
                "query or fragment",
            )
        ],
    )


def base_url_required_error() -> ApiError:
    return ApiError(
        422,
        "validation_failed",
        "Request validation failed",
        [
            ErrorDetail(
                loc=["body", "base_url"],
                code="base_url_required",
                message="A deployed mutant needs the address where its branch runs",
            )
        ],
    )


def run_active_error(mutant_name: str) -> ApiError:
    return ApiError(
        409,
        "conflict",
        "A mutation run of this mutant is in progress; wait for it to finish",
        [
            ErrorDetail(
                loc=["mutant"],
                code="mutation_run_active",
                message=f"{mutant_name!r} has a mutation run that has not finished",
            )
        ],
    )


def mutant_in_use_error(count: int) -> ApiError:
    return ApiError(
        409,
        "conflict",
        "The mutant has mutation runs and cannot be deleted; retire it instead",
        [
            ErrorDetail(
                loc=["mutant"],
                code="mutant_in_use",
                message=f"{count} mutation runs refer to this mutant",
            )
        ],
    )


def ensure_base_url_allowed(settings: Settings, base_url: str | None) -> None:
    if base_url is None:
        return
    if not is_plain_http_address(base_url):
        raise base_url_invalid_error()
    if matches_production_pattern(settings, base_url):
        raise production_url_error("base_url")


async def get_mutant_row(
    session: AsyncSession, mutant_id: uuid.UUID, lock: bool = False
) -> MutantRow:
    row = await session.get(MutantRow, mutant_id, with_for_update=lock)
    if row is None:
        raise not_found("Mutant not found")
    return row


async def name_is_taken(
    session: AsyncSession, target_id: uuid.UUID, name: str, except_id: uuid.UUID | None
) -> bool:
    conditions: list[ColumnElement[bool]] = [
        MutantRow.target_id == target_id,
        MutantRow.name == name,
    ]
    if except_id is not None:
        conditions.append(MutantRow.id != except_id)
    return await session.scalar(select(MutantRow.id).where(and_(*conditions)).limit(1)) is not None


async def has_active_mutation_run(session: AsyncSession, mutant_id: uuid.UUID) -> bool:
    found = await session.scalar(
        select(MutationRunRow.id)
        .join(RunRow, RunRow.id == MutationRunRow.run_id)
        .where(MutationRunRow.mutant_id == mutant_id, RunRow.status.in_(ACTIVE_RUN_STATUSES))
        .limit(1)
    )
    return found is not None


async def list_mutants(
    session: AsyncSession,
    query: PageQuery,
    target_id: uuid.UUID | None,
    statuses: Sequence[MutantStatus],
) -> MutantPage:
    statement = select(MutantRow)
    conditions: list[ColumnElement[bool]] = []
    if target_id is not None:
        conditions.append(MutantRow.target_id == target_id)
    if statuses:
        conditions.append(MutantRow.status.in_(list(statuses)))
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(session, statement, MUTANT_SORT_COLUMNS, MUTANT_ID_COLUMN, query)
    return MutantPage(
        items=[to_mutant(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def create_mutant(
    session: AsyncSession, settings: Settings, user: User, body: MutantCreate
) -> Mutant:
    target = await get_active_target(session, body.target_id)
    ensure_base_url_allowed(settings, body.base_url)
    vocabulary = await load_invariant_vocabulary(session, target.id)
    ensure_invariants_known(vocabulary, body.expected_catchers, ("body", "expected_catchers"))
    if await name_is_taken(session, target.id, body.name, None):
        raise duplicate_name_error(body.name)
    row = MutantRow(
        target_id=target.id,
        name=body.name,
        branch=body.branch,
        description=body.description,
        expected_catchers=list(body.expected_catchers),
        base_url=body.base_url,
        deployed_marker=marker_document(body.deployed_marker),
        status=MutantStatus.registered,
        last_outcome=None,
        created_by=user.id,
    )
    session.add(row)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise duplicate_name_error(body.name) from None
    await session.commit()
    MUTATION_SUMMARY_CACHE.clear()
    return to_mutant(row)


def changes_definition(body: MutantUpdate) -> bool:
    return any(field_name in body.model_fields_set for field_name in DEFINITION_FIELDS)


def final_base_url(row: MutantRow, body: MutantUpdate) -> str | None:
    return body.base_url if "base_url" in body.model_fields_set else row.base_url


def final_status(row: MutantRow, body: MutantUpdate) -> MutantStatus:
    return body.status if body.status is not None else row.status


def ensure_deployed_has_address(row: MutantRow, body: MutantUpdate) -> None:
    if final_status(row, body) is MutantStatus.deployed and final_base_url(row, body) is None:
        raise base_url_required_error()


async def apply_update(
    session: AsyncSession, settings: Settings, row: MutantRow, body: MutantUpdate
) -> None:
    if body.name is not None and body.name != row.name:
        if await name_is_taken(session, row.target_id, body.name, row.id):
            raise duplicate_name_error(body.name)
        row.name = body.name
    if body.branch is not None:
        row.branch = body.branch
    if body.description is not None:
        row.description = body.description
    if body.expected_catchers is not None:
        vocabulary = await load_invariant_vocabulary(session, row.target_id)
        ensure_invariants_known(vocabulary, body.expected_catchers, ("body", "expected_catchers"))
        row.expected_catchers = list(body.expected_catchers)
    if "base_url" in body.model_fields_set:
        ensure_base_url_allowed(settings, body.base_url)
        row.base_url = body.base_url
    if "deployed_marker" in body.model_fields_set:
        row.deployed_marker = marker_document(body.deployed_marker)
    if body.status is not None:
        row.status = body.status


async def update_mutant(
    session: AsyncSession, settings: Settings, mutant_id: uuid.UUID, body: MutantUpdate
) -> Mutant:
    row = await get_mutant_row(session, mutant_id, lock=True)
    if changes_definition(body) and await has_active_mutation_run(session, row.id):
        raise run_active_error(row.name)
    ensure_deployed_has_address(row, body)
    await apply_update(session, settings, row, body)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise duplicate_name_error(body.name or row.name) from None
    await session.commit()
    MUTATION_SUMMARY_CACHE.clear()
    return to_mutant(row)


async def delete_mutant(session: AsyncSession, mutant_id: uuid.UUID) -> None:
    row = await get_mutant_row(session, mutant_id, lock=True)
    used_by = await session.scalar(
        select(func.count()).select_from(MutationRunRow).where(MutationRunRow.mutant_id == row.id)
    )
    if used_by:
        raise mutant_in_use_error(used_by)
    await session.delete(row)
    await session.commit()
    MUTATION_SUMMARY_CACHE.clear()
