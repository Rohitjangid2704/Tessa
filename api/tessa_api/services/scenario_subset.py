import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, ScenarioRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import AdapterKind, Depth, InterfaceMode, ScenarioStatus
from tessa_api.schemas.plans import PlanCreate, PlanSelection
from tessa_api.services.plans import PlanEvaluation
from tessa_api.services.scenario_library import is_synthetic

SUBSET_PLAN_NAME = "subset"
CellKey = tuple[str, str, str]


@dataclass(frozen=True, slots=True)
class SubsetScenario:
    scenario_id: uuid.UUID
    feature_id: str
    role: str
    interface_id: str

    @property
    def cell_key(self) -> CellKey:
        return (self.feature_id, self.role, self.interface_id)


def not_runnable(details: Sequence[ErrorDetail]) -> ApiError:
    return ApiError(
        422,
        "scenarios_not_runnable",
        "Some of the scenarios cannot run in a subset run",
        list(details),
    )


def problem(position: int, code: str, message: str) -> ErrorDetail:
    return ErrorDetail(loc=["body", "scenario_ids", position], code=code, message=message)


def runnable_problem(
    position: int, row: ScenarioRow | None, target_id: uuid.UUID
) -> ErrorDetail | None:
    if row is None or row.target_id != target_id:
        return problem(
            position, "scenario_not_found", "The scenario does not exist for this target"
        )
    if row.status is not ScenarioStatus.accepted:
        return problem(
            position,
            "scenario_not_accepted",
            f"The scenario is {row.status.value}; only accepted scenarios can run",
        )
    if is_synthetic(row):
        return problem(
            position,
            "scenario_synthetic",
            "Synthetic scenarios belong to their own run and cannot be picked",
        )
    if row.feature_id is None or not row.parsed.get("role") or not row.parsed.get("interface_id"):
        return problem(
            position,
            "scenario_has_no_cell",
            "The scenario names no feature, role and interface, so it maps to no cell",
        )
    return None


async def load_subset(
    session: AsyncSession, target_id: uuid.UUID, scenario_ids: Sequence[uuid.UUID]
) -> list[SubsetScenario]:
    rows = await session.scalars(select(ScenarioRow).where(ScenarioRow.id.in_(list(scenario_ids))))
    by_id = {row.id: row for row in rows}
    details: list[ErrorDetail] = []
    chosen: list[SubsetScenario] = []
    for position, scenario_id in enumerate(scenario_ids):
        row = by_id.get(scenario_id)
        found = runnable_problem(position, row, target_id)
        if found is not None:
            details.append(found)
        elif row is not None and row.feature_id is not None:
            chosen.append(
                SubsetScenario(
                    scenario_id=row.id,
                    feature_id=row.feature_id,
                    role=str(row.parsed["role"]),
                    interface_id=str(row.parsed["interface_id"]),
                )
            )
    if details:
        raise not_runnable(details)
    return chosen


def interface_kinds_of(manifest: Mapping[str, Any] | None) -> dict[str, AdapterKind]:
    kinds: dict[str, AdapterKind] = {}
    interfaces = (manifest or {}).get("interfaces")
    for interface in interfaces if isinstance(interfaces, list) else []:
        if isinstance(interface, Mapping) and "id" in interface and "kind" in interface:
            try:
                kinds[str(interface["id"])] = AdapterKind(interface["kind"])
            except ValueError:
                continue
    return kinds


def interface_mode_for(
    scenarios: Sequence[SubsetScenario], kinds: Mapping[str, AdapterKind]
) -> InterfaceMode:
    browser = any(kinds.get(item.interface_id) is AdapterKind.browser for item in scenarios)
    other = any(kinds.get(item.interface_id) is not AdapterKind.browser for item in scenarios)
    if browser and other:
        return InterfaceMode.both
    return InterfaceMode.browser_only if browser else InterfaceMode.api_only


@dataclass(frozen=True, slots=True)
class SubsetPlan:
    plan: PlanCreate
    scenarios: tuple[SubsetScenario, ...]


async def build_subset_plan(
    session: AsyncSession, target: TargetRow, bundle: BundleRow, scenario_ids: Sequence[uuid.UUID]
) -> SubsetPlan:
    scenarios = await load_subset(session, target.id, scenario_ids)
    selection = PlanSelection(
        feature_ids=sorted({item.feature_id for item in scenarios}),
        area_ids=[],
        roles=sorted({item.role for item in scenarios}),
        interface_mode=interface_mode_for(scenarios, interface_kinds_of(bundle.manifest)),
        depth=Depth.smoke,
        k=1,
        budget=None,
    )
    plan = PlanCreate(
        target_id=target.id,
        bundle_id=bundle.id,
        name=SUBSET_PLAN_NAME,
        saved=False,
        selection=selection,
        include_api_fuzz=False,
    )
    return SubsetPlan(plan=plan, scenarios=tuple(scenarios))


def restrict_to_subset(
    evaluation: PlanEvaluation, scenarios: Sequence[SubsetScenario]
) -> PlanEvaluation:
    wanted = {item.cell_key for item in scenarios}
    cells = tuple(
        cell
        for cell in evaluation.expansion.cells
        if (cell.feature_id, cell.role, cell.interface_id) in wanted
    )
    present = {(cell.feature_id, cell.role, cell.interface_id) for cell in cells}
    details = [
        problem(
            position,
            "scenario_not_in_bundle",
            "The scenario belongs to a feature, role or interface that the latest valid bundle "
            "no longer offers",
        )
        for position, item in enumerate(scenarios)
        if item.cell_key not in present
    ]
    if details:
        raise not_runnable(details)
    return replace(evaluation, expansion=replace(evaluation.expansion, cells=cells))
