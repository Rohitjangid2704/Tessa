import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import ColumnElement, and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BundleRow,
    CoverageCellRow,
    EnvironmentRow,
    PlanRow,
    ScenarioRow,
)
from tessa_api.errors import not_found
from tessa_api.schemas.enums import ScenarioOrigin, ScenarioStatus
from tessa_api.schemas.scenarios import (
    Scenario,
    ScenarioSummary,
    ScenarioSummaryPage,
    ScenarioValidation,
)
from tessa_api.services.oracles import oracle_views_for_bundle
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.scenario_validator import (
    ScenarioBundleView,
    ScenarioCheck,
    build_scenario_view,
    validate_scenario_text,
)

SEARCH_ESCAPE = "\\"
REVIEWABLE_STATUSES = frozenset(
    {ScenarioStatus.draft, ScenarioStatus.validating, ScenarioStatus.invalid}
)

SCENARIO_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(ScenarioRow.created_at, datetime),
    "updated_at": sortable(ScenarioRow.updated_at, datetime),
    "title": sortable(ScenarioRow.title, str),
}
SCENARIO_ID_COLUMN = sortable(ScenarioRow.id, uuid.UUID)


@dataclass(frozen=True)
class ScenarioFilters:
    target_id: uuid.UUID | None = None
    statuses: Sequence[ScenarioStatus] = field(default_factory=tuple)
    origins: Sequence[ScenarioOrigin] = field(default_factory=tuple)
    families: Sequence[str] = field(default_factory=tuple)
    feature_ids: Sequence[str] = field(default_factory=tuple)
    cell_id: uuid.UUID | None = None
    plan_id: uuid.UUID | None = None
    query: str | None = None
    include_synthetic: bool = False


def escape_like(text: str) -> str:
    return (
        text.replace(SEARCH_ESCAPE, SEARCH_ESCAPE * 2)
        .replace("%", f"{SEARCH_ESCAPE}%")
        .replace("_", f"{SEARCH_ESCAPE}_")
    )


def is_synthetic(row: ScenarioRow) -> bool:
    return row.parsed.get("synthetic") is True


def to_scenario_summary(row: ScenarioRow) -> ScenarioSummary:
    return ScenarioSummary(
        id=row.id,
        target_id=row.target_id,
        bundle_id=row.bundle_id,
        feature_id=row.feature_id,
        cell_id=row.cell_id,
        title=row.title,
        family=row.family,
        origin=row.origin,
        status=row.status,
        version=row.version,
        synthetic=is_synthetic(row),
        validation=ScenarioValidation.model_validate(row.validation),
        provenance=row.provenance,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def to_scenario(row: ScenarioRow) -> Scenario:
    return Scenario(
        **to_scenario_summary(row).model_dump(),
        yaml=row.yaml,
        parsed=row.parsed,
    )


def covers_cell_condition(cell_condition: ColumnElement[bool]) -> ColumnElement[bool]:
    return exists(
        select(CoverageCellRow.id)
        .join(PlanRow, PlanRow.id == CoverageCellRow.plan_id)
        .where(
            cell_condition,
            PlanRow.target_id == ScenarioRow.target_id,
            CoverageCellRow.feature_id == ScenarioRow.feature_id,
            CoverageCellRow.role == ScenarioRow.parsed["role"].astext,
            CoverageCellRow.interface_id == ScenarioRow.parsed["interface_id"].astext,
        )
    )


def filter_conditions(filters: ScenarioFilters) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if filters.target_id is not None:
        conditions.append(ScenarioRow.target_id == filters.target_id)
    if filters.statuses:
        conditions.append(ScenarioRow.status.in_(list(filters.statuses)))
    if filters.origins:
        conditions.append(ScenarioRow.origin.in_(list(filters.origins)))
    if filters.families:
        conditions.append(ScenarioRow.family.in_(list(filters.families)))
    if filters.feature_ids:
        conditions.append(ScenarioRow.feature_id.in_(list(filters.feature_ids)))
    if filters.cell_id is not None:
        conditions.append(covers_cell_condition(CoverageCellRow.id == filters.cell_id))
    if filters.plan_id is not None:
        conditions.append(covers_cell_condition(CoverageCellRow.plan_id == filters.plan_id))
    if filters.query:
        pattern = f"%{escape_like(filters.query.strip())}%"
        conditions.append(
            or_(
                ScenarioRow.title.ilike(pattern, escape=SEARCH_ESCAPE),
                ScenarioRow.feature_id.ilike(pattern, escape=SEARCH_ESCAPE),
                ScenarioRow.family.ilike(pattern, escape=SEARCH_ESCAPE),
            )
        )
    if not filters.include_synthetic:
        conditions.append(
            or_(
                ScenarioRow.parsed["synthetic"].is_(None),
                ScenarioRow.parsed["synthetic"].as_boolean().is_(False),
            )
        )
    return conditions


async def list_scenarios(
    session: AsyncSession, query: PageQuery, filters: ScenarioFilters
) -> ScenarioSummaryPage:
    statement = select(ScenarioRow)
    conditions = filter_conditions(filters)
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(session, statement, SCENARIO_SORT_COLUMNS, SCENARIO_ID_COLUMN, query)
    return ScenarioSummaryPage(
        items=[to_scenario_summary(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def get_scenario_row(session: AsyncSession, scenario_id: uuid.UUID) -> ScenarioRow:
    row = await session.get(ScenarioRow, scenario_id)
    if row is None:
        raise not_found("Scenario not found")
    return row


async def read_scenario(session: AsyncSession, scenario_id: uuid.UUID) -> Scenario:
    return to_scenario(await get_scenario_row(session, scenario_id))


async def declared_environment_names(session: AsyncSession, target_id: uuid.UUID) -> frozenset[str]:
    names = await session.scalars(
        select(EnvironmentRow.name).where(
            EnvironmentRow.target_id == target_id, EnvironmentRow.stale.is_(False)
        )
    )
    return frozenset(names.all())


async def scenario_view_for_bundle(
    session: AsyncSession, target_id: uuid.UUID, bundle_id: uuid.UUID
) -> ScenarioBundleView:
    bundle = await session.get(BundleRow, bundle_id)
    manifest = bundle.manifest if bundle is not None else None
    return build_scenario_view(
        manifest,
        await declared_environment_names(session, target_id),
        await oracle_views_for_bundle(session, bundle_id),
    )


def status_after_validation(
    origin: ScenarioOrigin, current: ScenarioStatus, valid: bool
) -> ScenarioStatus:
    if not valid:
        return ScenarioStatus.invalid
    if origin is ScenarioOrigin.bundle_example:
        return ScenarioStatus.accepted
    if current in REVIEWABLE_STATUSES:
        return ScenarioStatus.in_review
    return current


async def validate_stored_scenario(
    session: AsyncSession, scenario_id: uuid.UUID
) -> ScenarioValidation:
    row = await get_scenario_row(session, scenario_id)
    view = await scenario_view_for_bundle(session, row.target_id, row.bundle_id)
    check = validate_scenario_text(row.yaml, view)
    apply_check(row, check)
    await session.flush()
    return check.validation


def apply_check(row: ScenarioRow, check: ScenarioCheck) -> None:
    row.validation = check.validation.model_dump(mode="json")
    if check.parsed is not None:
        row.parsed = check.parsed
    row.status = status_after_validation(row.origin, row.status, check.validation.valid)
