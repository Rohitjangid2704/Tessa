import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import ColumnElement, and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BundleRow,
    CoverageCellRow,
    EnvironmentRow,
    MutationRunRow,
    PlanRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
    ScheduleRow,
)
from tessa_api.db.models import Target as TargetRow
from tessa_api.errors import ApiError, not_found
from tessa_api.schemas.bundle_references import ALL_ROLES
from tessa_api.schemas.catalog import Catalog
from tessa_api.schemas.common import Budget, ErrorDetail
from tessa_api.schemas.enums import (
    BundleValidationStatus,
    CellStatus,
    RunKind,
    RunStatus,
    ScenarioStatus,
    SkipReason,
    SyntheticFamily,
    VerdictStatus,
)
from tessa_api.schemas.plans import (
    CoverageCell,
    CoverageCellPage,
    Plan,
    PlanCreate,
    PlanPage,
    PlanPreview,
    PlanSelection,
    PlanSkippedItem,
    PlanUpdate,
)
from tessa_api.services.bundle_validator import OPENAPI_FILE
from tessa_api.services.catalog_builder import CatalogFilters, read_catalog
from tessa_api.services.cell_status import CellChange, settle_plan_cells
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.plan_builder import (
    SUPPORTED_ADAPTER_KINDS,
    CellExpansion,
    EnvironmentVariableState,
    PlannedCell,
    PlanningContext,
    build_planning_context,
    expand_cells,
    plural,
    runnable_cells,
)
from tessa_api.services.run_guard import (
    ProductionAssessment,
    assess_production,
    bundle_missing_error,
    ensure_bundle_usable,
)
from tessa_api.services.settings_service import effective_settings
from tessa_api.services.smoke_generator import (
    SmokeBundleView,
    build_smoke_view,
    count_smoke_scenarios,
    load_bundle_flows,
    smoke_sources,
)
from tessa_api.services.storage import BundleStore
from tessa_api.services.targets import get_active_target, get_target
from tessa_api.services.vault import Vault
from tessa_api.settings import Settings

API_FUZZ_FAMILY = SyntheticFamily.api_fuzz.value
NON_TERMINAL_RUN_STATUSES = (
    RunStatus.queued,
    RunStatus.planning,
    RunStatus.seeding,
    RunStatus.running,
    RunStatus.canceling,
)
MAX_NAMED_CELLS = 5

PLAN_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(PlanRow.created_at, datetime),
}
PLAN_ID_COLUMN = sortable(PlanRow.id, uuid.UUID)
CELL_SORT_COLUMNS: dict[str, SortableColumn] = {
    "feature_id": sortable(CoverageCellRow.feature_id, str),
    "role": sortable(CoverageCellRow.role, str),
    "interface_id": sortable(CoverageCellRow.interface_id, str),
    "status": sortable(CoverageCellRow.status, str),
}
CELL_ID_COLUMN = sortable(CoverageCellRow.id, uuid.UUID)


@dataclass(frozen=True, slots=True)
class PlanEvaluation:
    target: TargetRow
    bundle: BundleRow
    catalog: Catalog
    context: PlanningContext
    expansion: CellExpansion
    assessment: ProductionAssessment
    budget: Budget


def plan_empty_error(loc_prefix: Sequence[str | int]) -> ApiError:
    return ApiError(
        422,
        "plan_empty",
        "The selection expands to no cells; select at least one feature",
        [
            ErrorDetail(
                loc=[*loc_prefix, "selection"], code="plan_empty", message="The selection is empty"
            )
        ],
    )


def validate_selection(
    selection: PlanSelection, settings: Settings, loc_prefix: Sequence[str | int]
) -> None:
    problems: list[ErrorDetail] = []
    if selection.k > settings.plan_max_k:
        problems.append(
            ErrorDetail(
                loc=[*loc_prefix, "selection", "k"],
                code="less_than_equal",
                message=f"Input should be less than or equal to {settings.plan_max_k}",
            )
        )
    if problems:
        raise ApiError(422, "validation_failed", "Request validation failed", problems)


def resolve_budget(selection: PlanSelection, settings: Settings) -> Budget:
    if selection.budget is not None:
        return selection.budget
    return Budget(
        max_usd=settings.run_default_max_usd, max_minutes=settings.run_default_max_minutes
    )


async def latest_valid_bundle(session: AsyncSession, target_id: uuid.UUID) -> BundleRow | None:
    return await session.scalar(
        select(BundleRow)
        .where(
            BundleRow.target_id == target_id,
            BundleRow.validation_status == BundleValidationStatus.valid,
        )
        .order_by(BundleRow.version.desc())
        .limit(1)
    )


async def resolve_plan_bundle(
    session: AsyncSession,
    target: TargetRow,
    bundle_id: uuid.UUID | None,
    loc_prefix: Sequence[str | int],
) -> BundleRow:
    if bundle_id is None:
        return ensure_bundle_usable(await latest_valid_bundle(session, target.id))
    bundle = await session.get(BundleRow, bundle_id)
    if bundle is None or bundle.target_id != target.id:
        raise not_found("Bundle not found")
    if bundle.validation_status is not BundleValidationStatus.valid:
        raise ApiError(
            422,
            "validation_failed",
            "Request validation failed",
            [
                ErrorDetail(
                    loc=[*loc_prefix, "bundle_id"],
                    code="bundle_invalid",
                    message=f"Bundle v{bundle.version} did not validate",
                )
            ],
        )
    return bundle


async def load_environment_states(
    session: AsyncSession, target_id: uuid.UUID
) -> list[EnvironmentVariableState]:
    rows = (
        await session.scalars(
            select(EnvironmentRow)
            .where(EnvironmentRow.target_id == target_id, EnvironmentRow.stale.is_(False))
            .order_by(EnvironmentRow.name)
        )
    ).all()
    return [
        EnvironmentVariableState(
            name=row.name,
            kind=row.kind,
            required=row.required,
            interface_ids=frozenset(row.interface_ids),
            has_value=row.encrypted_value is not None,
        )
        for row in rows
    ]


async def build_context(
    session: AsyncSession, bundle: BundleRow, read_only: bool
) -> PlanningContext:
    variables = await load_environment_states(session, bundle.target_id)
    return build_planning_context(bundle.manifest, variables, read_only)


async def evaluate_selection(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    target: TargetRow,
    bundle: BundleRow,
    selection: PlanSelection,
) -> PlanEvaluation:
    assessment = await assess_production(session, settings, vault, target)
    catalog = await read_catalog(session, target.id, bundle.id, CatalogFilters())
    context = await build_context(session, bundle, assessment.production)
    return PlanEvaluation(
        target=target,
        bundle=bundle,
        catalog=catalog,
        context=context,
        expansion=expand_cells(catalog, selection, context),
        assessment=assessment,
        budget=resolve_budget(selection, await effective_settings(session, settings)),
    )


def cells_without_sources(view: SmokeBundleView, cells: Sequence[PlannedCell]) -> list[PlannedCell]:
    return [
        cell
        for cell in cells
        if not smoke_sources(view, cell.feature_id, cell.role, cell.interface_id)
    ]


def preview_warnings(evaluation: PlanEvaluation, view: SmokeBundleView) -> list[str]:
    warnings = list(evaluation.expansion.warnings)
    if not evaluation.expansion.cells:
        warnings.append("The selection expands to no cells; select at least one feature")
    if evaluation.assessment.blocked:
        warnings.append(
            "The target is a production target and an admin has not enabled allow_production, "
            "so runs are blocked"
        )
    bare = cells_without_sources(view, runnable_cells(evaluation.expansion.cells))
    if bare:
        named = ", ".join(
            f"{cell.feature_id} ({cell.role} on {cell.interface_id})"
            for cell in bare[:MAX_NAMED_CELLS]
        )
        more = f" and {len(bare) - MAX_NAMED_CELLS} more" if len(bare) > MAX_NAMED_CELLS else ""
        warnings.append(
            f"{plural(len(bare), 'cell')} have no bundle example or flow to build a smoke "
            f"scenario from: {named}{more}"
        )
    return warnings


def bundle_has_openapi(bundle: BundleRow) -> bool:
    return any(entry.get("path") == OPENAPI_FILE for entry in bundle.files)


def fuzz_roles(catalog: Catalog, selection: PlanSelection) -> list[str]:
    declared = [role.id for role in catalog.roles]
    if not selection.roles or ALL_ROLES in selection.roles:
        return declared
    return [role for role in declared if role in set(selection.roles)]


@dataclass(frozen=True, slots=True)
class ApiFuzzOutlook:
    scenarios: int
    skipped: tuple[PlanSkippedItem, ...]
    warnings: tuple[str, ...]


def api_fuzz_outlook(evaluation: PlanEvaluation, selection: PlanSelection) -> ApiFuzzOutlook:
    roles = fuzz_roles(evaluation.catalog, selection)
    if bundle_has_openapi(evaluation.bundle):
        return ApiFuzzOutlook(len(roles), (), ())
    skipped = tuple(
        PlanSkippedItem(
            feature_id=API_FUZZ_FAMILY,
            role=role,
            interface_id=None,
            reason=SkipReason.precondition_failed,
        )
        for role in roles
    )
    warning = (
        f"The API fuzz family is skipped because bundle v{evaluation.bundle.version} has no "
        f"{OPENAPI_FILE}"
    )
    return ApiFuzzOutlook(0, skipped, (warning,))


def estimated_cost(runnable: Sequence[PlannedCell], settings: Settings) -> float:
    return round(len(runnable) * settings.plan_estimate_cost_per_cell_usd, 6)


async def preview_plan(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    store: BundleStore,
    body: PlanCreate,
) -> PlanPreview:
    target = await get_target(session, body.target_id)
    validate_selection(body.selection, settings, ["body"])
    bundle = await resolve_plan_bundle(session, target, body.bundle_id, ["body"])
    evaluation = await evaluate_selection(session, settings, vault, target, bundle, body.selection)
    view = build_smoke_view(bundle.manifest, await load_bundle_flows(store, bundle))
    runnable = runnable_cells(evaluation.expansion.cells)
    fuzz = (
        api_fuzz_outlook(evaluation, body.selection)
        if body.include_api_fuzz
        else ApiFuzzOutlook(0, (), ())
    )
    return PlanPreview(
        cells_total=len(evaluation.expansion.cells),
        scenarios_estimated=count_smoke_scenarios(
            view, [(cell.feature_id, cell.role, cell.interface_id) for cell in runnable]
        )
        + fuzz.scenarios,
        skipped=[*evaluation.expansion.skipped, *fuzz.skipped],
        warnings=[*preview_warnings(evaluation, view), *fuzz.warnings],
        effective_budget=evaluation.budget,
        estimated_cost_usd=estimated_cost(runnable, settings),
    )


def initial_cell_status(cell: PlannedCell) -> CellStatus:
    if cell.interface_kind not in SUPPORTED_ADAPTER_KINDS:
        return CellStatus.blocked
    return CellStatus.empty


def cell_key(cell: CoverageCellRow | PlannedCell) -> tuple[str, str, str]:
    return cell.feature_id, cell.role, cell.interface_id


async def materialize_cells(
    session: AsyncSession, plan_id: uuid.UUID, cells: Sequence[PlannedCell]
) -> list[CoverageCellRow]:
    existing = {
        cell_key(row): row
        for row in (
            await session.scalars(select(CoverageCellRow).where(CoverageCellRow.plan_id == plan_id))
        ).all()
    }
    wanted = {cell_key(cell): cell for cell in cells}
    for key, stale in existing.items():
        if key not in wanted:
            await session.delete(stale)
    materialised: list[CoverageCellRow] = []
    for key, planned in wanted.items():
        row = existing.get(key)
        if row is None:
            row = CoverageCellRow(
                plan_id=plan_id,
                feature_id=planned.feature_id,
                role=planned.role,
                interface_id=planned.interface_id,
                family=planned.family,
                status=initial_cell_status(planned),
            )
            session.add(row)
        else:
            row.family = planned.family
        materialised.append(row)
    await session.flush()
    return materialised


async def cell_counts(session: AsyncSession, plan_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not plan_ids:
        return {}
    rows = await session.execute(
        select(CoverageCellRow.plan_id, func.count())
        .where(CoverageCellRow.plan_id.in_(list(plan_ids)))
        .group_by(CoverageCellRow.plan_id)
    )
    counts: dict[uuid.UUID, int] = {}
    for plan_id, count in rows:
        counts[plan_id] = count
    return counts


def to_plan(row: PlanRow, cells_total: int) -> Plan:
    return Plan(
        id=row.id,
        target_id=row.target_id,
        bundle_id=row.bundle_id,
        name=row.name,
        saved=row.saved,
        selection=PlanSelection.model_validate(row.selection),
        effective_budget=Budget.model_validate(row.budget),
        is_coverage_baseline=row.is_coverage_baseline,
        include_api_fuzz=row.include_api_fuzz,
        cells_total=cells_total,
        schedule_id=row.schedule_id,
        created_by=row.created_by,
        created_at=row.created_at,
    )


async def get_plan_row(session: AsyncSession, plan_id: uuid.UUID) -> PlanRow:
    row = await session.get(PlanRow, plan_id)
    if row is None:
        raise not_found("Plan not found")
    return row


async def read_plan(session: AsyncSession, plan_id: uuid.UUID) -> Plan:
    row = await get_plan_row(session, plan_id)
    counts = await cell_counts(session, [row.id])
    return to_plan(row, counts.get(row.id, 0))


def plan_fields(selection: PlanSelection, budget: Budget) -> dict[str, Any]:
    return {
        "selection": selection.model_dump(mode="json"),
        "depth": selection.depth,
        "k": selection.k,
        "budget": budget.model_dump(mode="json"),
    }


def insert_plan(
    session: AsyncSession,
    target: TargetRow,
    bundle: BundleRow,
    user_id: uuid.UUID,
    name: str | None,
    saved: bool,
    selection: PlanSelection,
    budget: Budget,
    include_api_fuzz: bool = False,
) -> PlanRow:
    row = PlanRow(
        target_id=target.id,
        bundle_id=bundle.id,
        name=name,
        saved=saved,
        include_api_fuzz=include_api_fuzz,
        created_by=user_id,
        **plan_fields(selection, budget),
    )
    session.add(row)
    return row


async def create_plan(
    session: AsyncSession, settings: Settings, vault: Vault, user_id: uuid.UUID, body: PlanCreate
) -> Plan:
    target = await get_active_target(session, body.target_id)
    validate_selection(body.selection, settings, ["body"])
    bundle = await resolve_plan_bundle(session, target, body.bundle_id, ["body"])
    evaluation = await evaluate_selection(session, settings, vault, target, bundle, body.selection)
    if not evaluation.expansion.cells:
        raise plan_empty_error(["body"])
    row = insert_plan(
        session,
        target,
        bundle,
        user_id,
        body.name,
        body.saved,
        body.selection,
        evaluation.budget,
        body.include_api_fuzz,
    )
    await session.flush()
    cells = await materialize_cells(session, row.id, evaluation.expansion.cells)
    return to_plan(row, len(cells))


async def has_active_runs(session: AsyncSession, plan_id: uuid.UUID) -> bool:
    found = await session.scalar(
        select(RunRow.id)
        .where(RunRow.plan_id == plan_id, RunRow.status.in_(NON_TERMINAL_RUN_STATUSES))
        .limit(1)
    )
    return found is not None


async def has_dependents(session: AsyncSession, plan_id: uuid.UUID) -> bool:
    schedule_id = await session.scalar(
        select(ScheduleRow.id).where(ScheduleRow.plan_id == plan_id).limit(1)
    )
    if schedule_id is not None:
        return True
    mutation_run_id = await session.scalar(
        select(MutationRunRow.id).where(MutationRunRow.plan_id == plan_id).limit(1)
    )
    return mutation_run_id is not None


def plan_in_use_error() -> ApiError:
    return ApiError(409, "conflict", "The plan has a run in progress; wait for it to finish")


def plan_has_dependents_error() -> ApiError:
    return ApiError(
        409, "conflict", "A schedule or a mutation run uses the plan; remove them before the plan"
    )


def baseline_plan_error() -> ApiError:
    return ApiError(
        409,
        "conflict",
        "The coverage baseline plan is managed by Tessa and cannot be changed or deleted",
    )


async def update_plan(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    plan_id: uuid.UUID,
    body: PlanUpdate,
) -> Plan:
    row = await get_plan_row(session, plan_id)
    if row.is_coverage_baseline:
        raise baseline_plan_error()
    target = await get_active_target(session, row.target_id)
    if body.selection is not None:
        if await has_active_runs(session, row.id):
            raise plan_in_use_error()
        validate_selection(body.selection, settings, ["body"])
        bundle = ensure_bundle_usable(await latest_valid_bundle(session, target.id))
        evaluation = await evaluate_selection(
            session, settings, vault, target, bundle, body.selection
        )
        if not evaluation.expansion.cells:
            raise plan_empty_error(["body"])
        row.bundle_id = bundle.id
        for field_name, value in plan_fields(body.selection, evaluation.budget).items():
            setattr(row, field_name, value)
        await materialize_cells(session, row.id, evaluation.expansion.cells)
    if "name" in body.model_fields_set:
        row.name = body.name
    await session.flush()
    counts = await cell_counts(session, [row.id])
    return to_plan(row, counts.get(row.id, 0))


async def delete_plan(session: AsyncSession, plan_id: uuid.UUID) -> None:
    row = await get_plan_row(session, plan_id)
    if row.is_coverage_baseline:
        raise baseline_plan_error()
    if await has_active_runs(session, row.id):
        raise plan_in_use_error()
    if await has_dependents(session, row.id):
        raise plan_has_dependents_error()
    await session.delete(row)
    await session.flush()


async def list_plans(
    session: AsyncSession, query: PageQuery, target_id: uuid.UUID | None, saved: bool | None
) -> PlanPage:
    statement = select(PlanRow)
    conditions: list[ColumnElement[bool]] = [PlanRow.is_coverage_baseline.is_(False)]
    if target_id is not None:
        conditions.append(PlanRow.target_id == target_id)
    if saved is not None:
        conditions.append(PlanRow.saved.is_(saved))
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(session, statement, PLAN_SORT_COLUMNS, PLAN_ID_COLUMN, query)
    rows: list[PlanRow] = [row[0] for row in page.rows]
    counts = await cell_counts(session, [row.id for row in rows])
    return PlanPage(
        items=[to_plan(row, counts.get(row.id, 0)) for row in rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def accepted_counts(
    session: AsyncSession, target_id: uuid.UUID, rows: Sequence[CoverageCellRow]
) -> Mapping[tuple[str, str, str], int]:
    if not rows:
        return {}
    role = ScenarioRow.parsed["role"].astext
    interface_id = ScenarioRow.parsed["interface_id"].astext
    grouped = await session.execute(
        select(ScenarioRow.feature_id, role, interface_id, func.count())
        .where(
            ScenarioRow.target_id == target_id,
            ScenarioRow.status == ScenarioStatus.accepted,
            ScenarioRow.feature_id.in_({row.feature_id for row in rows}),
        )
        .group_by(ScenarioRow.feature_id, role, interface_id)
    )
    return {(feature, role_id, interface): count for feature, role_id, interface, count in grouped}


def to_coverage_cell(row: CoverageCellRow, scenario_count: int) -> CoverageCell:
    return CoverageCell(
        id=row.id,
        plan_id=row.plan_id,
        feature_id=row.feature_id,
        role=row.role,
        interface_id=row.interface_id,
        family=row.family,
        status=row.status,
        scenario_count=scenario_count,
        last_verdict=row.last_verdict,
        reason=row.reason,
        skip_reason=row.skip_reason,
    )


async def list_plan_cells(
    session: AsyncSession,
    plan_id: uuid.UUID,
    query: PageQuery,
    statuses: Sequence[CellStatus],
    feature_ids: Sequence[str],
) -> CoverageCellPage:
    plan = await get_plan_row(session, plan_id)
    conditions = [CoverageCellRow.plan_id == plan_id]
    if statuses:
        conditions.append(CoverageCellRow.status.in_(list(statuses)))
    if feature_ids:
        conditions.append(CoverageCellRow.feature_id.in_(list(feature_ids)))
    page = await paginate(
        session,
        select(CoverageCellRow).where(and_(*conditions)),
        CELL_SORT_COLUMNS,
        CELL_ID_COLUMN,
        query,
    )
    rows: list[CoverageCellRow] = [row[0] for row in page.rows]
    counts = await accepted_counts(session, plan.target_id, rows)
    return CoverageCellPage(
        items=[to_coverage_cell(row, counts.get(cell_key(row), 0)) for row in rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def plan_expansion(
    session: AsyncSession, plan_id: uuid.UUID, read_only: bool | None
) -> tuple[PlanRow, CellExpansion]:
    plan = await get_plan_row(session, plan_id)
    bundle = await session.get(BundleRow, plan.bundle_id)
    if bundle is None:
        raise bundle_missing_error()
    catalog = await read_catalog(session, plan.target_id, bundle.id, CatalogFilters())
    context = None if read_only is None else await build_context(session, bundle, read_only)
    selection = PlanSelection.model_validate(plan.selection)
    return plan, expand_cells(catalog, selection, context)


async def expand_plan_cells(session: AsyncSession, plan_id: uuid.UUID) -> list[uuid.UUID]:
    plan, expansion = await plan_expansion(session, plan_id, None)
    rows = await materialize_cells(session, plan.id, expansion.cells)
    return [row.id for row in rows]


async def plan_cells_with_skips(
    session: AsyncSession, plan_id: uuid.UUID, read_only: bool
) -> CellExpansion:
    _, expansion = await plan_expansion(session, plan_id, read_only)
    return expansion


VERDICT_PRECEDENCE = (
    VerdictStatus.fail,
    VerdictStatus.flaky,
    VerdictStatus.uncertain,
    VerdictStatus.pass_,
    VerdictStatus.skipped,
)


def worst_verdict(statuses: Iterable[VerdictStatus]) -> VerdictStatus:
    present = set(statuses)
    return next(status for status in VERDICT_PRECEDENCE if status in present)


@dataclass(frozen=True, slots=True)
class CellVerdictOutcome:
    updated: int
    changes: list[CellChange]


async def record_cell_verdicts(session: AsyncSession, run_id: uuid.UUID) -> int:
    return (await record_cell_verdicts_with_changes(session, run_id)).updated


async def record_cell_verdicts_with_changes(
    session: AsyncSession, run_id: uuid.UUID
) -> CellVerdictOutcome:
    run = await session.get(RunRow, run_id)
    if run is None or run.plan_id is None or run.kind is not RunKind.suite:
        return CellVerdictOutcome(0, [])
    rows = await session.execute(
        select(
            ScenarioRow.feature_id,
            RunScenarioRow.role,
            RunScenarioRow.interface_id,
            RunScenarioRow.verdict["status"].astext,
        )
        .join(ScenarioRow, ScenarioRow.id == RunScenarioRow.scenario_id)
        .where(RunScenarioRow.run_id == run_id, RunScenarioRow.verdict.is_not(None))
    )
    verdicts: dict[tuple[str, str, str], list[VerdictStatus]] = {}
    for feature_id, role, interface_id, status in rows:
        if feature_id is not None:
            verdicts.setdefault((feature_id, role, interface_id), []).append(VerdictStatus(status))
    cells = (
        await session.scalars(select(CoverageCellRow).where(CoverageCellRow.plan_id == run.plan_id))
    ).all()
    updated = 0
    for cell in cells:
        statuses = verdicts.get(cell_key(cell))
        if not statuses:
            continue
        cell.last_verdict = worst_verdict(statuses)
        updated += 1
    await session.flush()
    return CellVerdictOutcome(updated, await settle_plan_cells(session, run.plan_id))
