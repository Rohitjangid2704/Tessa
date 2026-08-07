import uuid
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, CoverageCellRow, PlanRow, RunRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.errors import not_found
from tessa_api.schemas.catalog import Catalog, CatalogItem
from tessa_api.schemas.common import Budget
from tessa_api.schemas.coverage import (
    CoverageColumn,
    CoverageMap,
    CoverageRow,
    CoverageTotals,
)
from tessa_api.schemas.enums import (
    CellStatus,
    Depth,
    InterfaceMode,
    RunKind,
    RunStatus,
    RunTrigger,
    ScenarioStatus,
)
from tessa_api.schemas.plans import CoverageCell, PlanSelection
from tessa_api.schemas.temporal import (
    plan_coverage_workflow_id,
)
from tessa_api.services.catalog_builder import CatalogFilters, read_catalog
from tessa_api.services.cell_rules import (
    CellDecision,
    CellKey,
    ScenarioFact,
    author_reason,
    decide_cell,
    manifest_declares_seed,
    skip_explanation,
)
from tessa_api.services.cell_status import (
    other_roles_of,
    scenario_facts,
    sibling_role_counts,
)
from tessa_api.services.hello import zero_run_counters
from tessa_api.services.plan_builder import (
    CellExpansion,
    PlanningContext,
    expand_cells,
)
from tessa_api.services.plans import (
    build_context,
    cell_key,
    insert_plan,
    latest_valid_bundle,
    materialize_cells,
    resolve_budget,
)
from tessa_api.services.run_guard import (
    assess_production,
    bundle_missing_error,
    ensure_bundle_usable,
)
from tessa_api.services.run_service import (
    initial_config_snapshot,
)
from tessa_api.services.settings_service import effective_settings
from tessa_api.services.smoke_generator import (
    build_smoke_view,
    load_bundle_flows,
    smoke_sources,
)
from tessa_api.services.storage import BundleStore, bundle_store_from_settings
from tessa_api.services.targets import get_target
from tessa_api.services.vault import Vault, vault_from_settings
from tessa_api.settings import Settings

BASELINE_DEPTH = Depth.smoke
BASELINE_K = 1
TITLE_MAX_CHARS = 120


@dataclass(frozen=True, slots=True)
class CoverageQuery:
    target_id: uuid.UUID
    plan_id: uuid.UUID | None = None
    bundle_id: uuid.UUID | None = None
    areas: Sequence[str] = ()
    statuses: Sequence[CellStatus] = ()


@dataclass(frozen=True, slots=True)
class EvaluatedCell:
    row: CoverageCellRow
    item: CatalogItem | None
    decision: CellDecision
    author_reason: str | None
    accepted_count: int


@dataclass(frozen=True, slots=True)
class CoverageEvaluation:
    plan: PlanRow
    bundle: BundleRow
    catalog: Catalog
    context: PlanningContext
    expansion: CellExpansion
    cells: list[EvaluatedCell]


def baseline_selection(catalog: Catalog) -> PlanSelection:
    return PlanSelection(
        feature_ids=[],
        area_ids=[area.name for area in catalog.areas],
        roles=[],
        interface_mode=InterfaceMode.both,
        depth=BASELINE_DEPTH,
        k=BASELINE_K,
        budget=None,
    )


async def find_baseline_plan(
    session: AsyncSession, target_id: uuid.UUID, bundle_id: uuid.UUID
) -> PlanRow | None:
    return await session.scalar(
        select(PlanRow).where(
            PlanRow.target_id == target_id,
            PlanRow.bundle_id == bundle_id,
            PlanRow.is_coverage_baseline.is_(True),
        )
    )


async def lock_baseline(session: AsyncSession, target_id: uuid.UUID, bundle_id: uuid.UUID) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"baseline:{target_id}:{bundle_id}"},
    )


async def ensure_baseline_plan(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    bundle: BundleRow,
    owner_id: uuid.UUID,
) -> PlanRow:
    existing = await find_baseline_plan(session, target.id, bundle.id)
    if existing is not None:
        return existing
    await lock_baseline(session, target.id, bundle.id)
    existing = await find_baseline_plan(session, target.id, bundle.id)
    if existing is not None:
        return existing
    catalog = await read_catalog(session, target.id, bundle.id, CatalogFilters())
    selection = baseline_selection(catalog)
    budget = resolve_budget(selection, await effective_settings(session, settings))
    plan = insert_plan(session, target, bundle, owner_id, None, False, selection, budget)
    plan.is_coverage_baseline = True
    await session.flush()
    await materialize_cells(session, plan.id, expand_cells(catalog, selection).cells)
    return plan


async def settled_baseline_plan(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    bundle: BundleRow,
    owner_id: uuid.UUID,
    refresh: bool = False,
) -> PlanRow:
    existing = await find_baseline_plan(session, target.id, bundle.id)
    plan = (
        existing
        if existing is not None
        else await ensure_baseline_plan(session, settings, target, bundle, owner_id)
    )
    if existing is None or refresh:
        await evaluate_plan_cells(
            session,
            settings,
            vault_from_settings(settings),
            bundle_store_from_settings(settings),
            target,
            plan,
        )
    return plan


async def resolve_cell(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    bundle: BundleRow,
    feature_id: str | None,
    role: str,
    interface_id: str,
    owner_id: uuid.UUID,
) -> CoverageCellRow | None:
    if feature_id is None:
        return None
    plan = await ensure_baseline_plan(session, settings, target, bundle, owner_id)
    return await session.scalar(
        select(CoverageCellRow).where(
            CoverageCellRow.plan_id == plan.id,
            CoverageCellRow.feature_id == feature_id,
            CoverageCellRow.role == role,
            CoverageCellRow.interface_id == interface_id,
        )
    )


def feature_title(item: CatalogItem | None, feature_id: str) -> str:
    if item is None:
        return feature_id
    first_line = item.description.strip().splitlines()[0] if item.description.strip() else ""
    shown = first_line or feature_id
    return shown if len(shown) <= TITLE_MAX_CHARS else f"{shown[: TITLE_MAX_CHARS - 3]}..."


def accepted_in(facts: Sequence[ScenarioFact]) -> int:
    return sum(1 for fact in facts if fact.status is ScenarioStatus.accepted)


def persist_decision(row: CoverageCellRow, decision: CellDecision) -> None:
    row.status = decision.status
    row.reason = decision.reason
    row.skip_reason = decision.skip_reason


async def load_plan_for_target(
    session: AsyncSession, plan_id: uuid.UUID, target_id: uuid.UUID
) -> PlanRow:
    plan = await session.get(PlanRow, plan_id)
    if plan is None or plan.target_id != target_id:
        raise not_found("Plan not found for this target")
    return plan


async def evaluate_plan_cells(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    store: BundleStore,
    target: TargetRow,
    plan: PlanRow,
) -> CoverageEvaluation:
    bundle = await session.get(BundleRow, plan.bundle_id)
    if bundle is None:
        raise bundle_missing_error()
    assessment = await assess_production(session, settings, vault, target)
    catalog = await read_catalog(session, target.id, bundle.id, CatalogFilters())
    context = await build_context(session, bundle, assessment.production)
    expansion = expand_cells(catalog, PlanSelection.model_validate(plan.selection), context)
    planned_by_key = {cell_key(cell): cell for cell in expansion.cells}
    rows = list(
        await session.scalars(
            select(CoverageCellRow)
            .where(CoverageCellRow.plan_id == plan.id)
            .order_by(
                CoverageCellRow.feature_id, CoverageCellRow.role, CoverageCellRow.interface_id
            )
        )
    )
    items = {item.feature_id: item for area in catalog.areas for item in area.items}
    facts = await scenario_facts(session, target.id, {row.feature_id for row in rows})
    siblings = await sibling_role_counts(session, [plan.id])
    smoke_view = build_smoke_view(bundle.manifest, await load_bundle_flows(store, bundle))
    seed_declared = manifest_declares_seed(bundle.manifest)
    evaluated: list[EvaluatedCell] = []
    for row in rows:
        key: CellKey = cell_key(row)
        planned = planned_by_key.get(key)
        skip = planned.skip_reason if planned is not None else None
        item = items.get(row.feature_id)
        has_sources = bool(smoke_sources(smoke_view, row.feature_id, row.role, row.interface_id))
        static_reason = (
            author_reason(item, has_sources, seed_declared) if item is not None else None
        )
        cell_facts = facts.get(key, [])
        decision = decide_cell(
            skip,
            skip_explanation(skip, context, row.role, row.interface_id) if skip else None,
            cell_facts,
            plan.depth,
            other_roles_of(siblings, row),
            static_reason,
            row.status,
            row.reason,
        )
        persist_decision(row, decision)
        evaluated.append(EvaluatedCell(row, item, decision, static_reason, accepted_in(cell_facts)))
    await session.flush()
    return CoverageEvaluation(plan, bundle, catalog, context, expansion, evaluated)


def to_coverage_cell(cell: EvaluatedCell) -> CoverageCell:
    row = cell.row
    return CoverageCell(
        id=row.id,
        plan_id=row.plan_id,
        feature_id=row.feature_id,
        role=row.role,
        interface_id=row.interface_id,
        family=row.family,
        status=cell.decision.status,
        scenario_count=cell.accepted_count,
        last_verdict=row.last_verdict,
        reason=cell.decision.reason,
        skip_reason=cell.decision.skip_reason,
    )


def kept_cells(evaluation: CoverageEvaluation, query: CoverageQuery) -> list[EvaluatedCell]:
    areas = set(query.areas)
    statuses = set(query.statuses)
    return [
        cell
        for cell in evaluation.cells
        if (not areas or (cell.item is not None and cell.item.area in areas))
        and (not statuses or cell.decision.status in statuses)
    ]


def coverage_rows(catalog: Catalog, cells: Sequence[EvaluatedCell]) -> list[CoverageRow]:
    wanted = {cell.row.feature_id for cell in cells}
    rows: list[CoverageRow] = []
    seen: set[str] = set()
    for area in catalog.areas:
        for item in area.items:
            if item.feature_id in wanted:
                seen.add(item.feature_id)
                rows.append(
                    CoverageRow(
                        feature_id=item.feature_id,
                        area=item.area,
                        title=feature_title(item, item.feature_id),
                    )
                )
    rows.extend(
        CoverageRow(feature_id=feature_id, area="", title=feature_id)
        for feature_id in sorted(wanted - seen)
    )
    return rows


def coverage_columns(catalog: Catalog, cells: Sequence[EvaluatedCell]) -> list[CoverageColumn]:
    role_order = {role.id: index for index, role in enumerate(catalog.roles)}
    interface_order = {interface.id: index for index, interface in enumerate(catalog.interfaces)}
    pairs = {(cell.row.role, cell.row.interface_id) for cell in cells}
    ordered = sorted(
        pairs,
        key=lambda pair: (
            role_order.get(pair[0], len(role_order)),
            pair[0],
            interface_order.get(pair[1], len(interface_order)),
            pair[1],
        ),
    )
    return [CoverageColumn(role=role, interface_id=interface_id) for role, interface_id in ordered]


def coverage_totals(cells: Sequence[EvaluatedCell]) -> CoverageTotals:
    counts = Counter(cell.decision.status for cell in cells)
    return CoverageTotals(
        empty=counts[CellStatus.empty],
        generated=counts[CellStatus.generated],
        covered=counts[CellStatus.covered],
        needs_author=counts[CellStatus.needs_author],
        blocked=counts[CellStatus.blocked],
    )


async def resolve_coverage_plan(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    query: CoverageQuery,
    owner_id: uuid.UUID,
) -> PlanRow:
    if query.plan_id is not None:
        return await load_plan_for_target(session, query.plan_id, target.id)
    if query.bundle_id is None:
        bundle = ensure_bundle_usable(await latest_valid_bundle(session, target.id))
    else:
        found = await session.get(BundleRow, query.bundle_id)
        if found is None or found.target_id != target.id:
            raise not_found("Bundle not found for this target")
        bundle = ensure_bundle_usable(found)
    return await ensure_baseline_plan(session, settings, target, bundle, owner_id)


async def read_coverage(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    store: BundleStore,
    owner_id: uuid.UUID,
    query: CoverageQuery,
) -> CoverageMap:
    target = await get_target(session, query.target_id)
    plan = await resolve_coverage_plan(session, settings, target, query, owner_id)
    evaluation = await evaluate_plan_cells(session, settings, vault, store, target, plan)
    cells = kept_cells(evaluation, query)
    return CoverageMap(
        target_id=target.id,
        plan_id=plan.id,
        bundle_id=evaluation.bundle.id,
        rows=coverage_rows(evaluation.catalog, cells),
        columns=coverage_columns(evaluation.catalog, cells),
        cells=[to_coverage_cell(cell) for cell in cells],
        totals=coverage_totals(cells),
    )


def new_generate_run(
    run_id: uuid.UUID,
    plan: PlanRow,
    bundle: BundleRow,
    budget: Budget,
    user_id: uuid.UUID,
) -> RunRow:
    return RunRow(
        id=run_id,
        kind=RunKind.generate,
        target_id=plan.target_id,
        plan_id=plan.id,
        bundle_id=bundle.id,
        status=RunStatus.queued,
        trigger=RunTrigger.manual,
        read_only=False,
        config_snapshot=initial_config_snapshot(bundle).model_dump(mode="json"),
        budget=budget.model_dump(mode="json"),
        counters=zero_run_counters().model_dump(mode="json"),
        workflow_id=plan_coverage_workflow_id(run_id),
        created_by=user_id,
        created_at=datetime.now(UTC),
    )


async def default_budget(session: AsyncSession, settings: Settings) -> Budget:
    effective = await effective_settings(session, settings)
    return Budget(
        max_usd=effective.run_default_max_usd, max_minutes=effective.run_default_max_minutes
    )
