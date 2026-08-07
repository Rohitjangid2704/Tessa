import uuid
from collections import defaultdict
from collections.abc import Collection, Sequence
from dataclasses import dataclass

from sqlalchemy import func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import CoverageCellRow, PlanRow, ScenarioRow
from tessa_api.schemas.enums import CellStatus
from tessa_api.services.cell_rules import (
    SETTLED_FROM_SCENARIOS,
    CellKey,
    ScenarioFact,
    settled_status,
    variant_of,
)

SCENARIO_ROLE = ScenarioRow.parsed["role"].astext
SCENARIO_INTERFACE = ScenarioRow.parsed["interface_id"].astext


@dataclass(frozen=True, slots=True)
class CellChange:
    plan_id: uuid.UUID
    target_id: uuid.UUID
    cell_id: uuid.UUID
    previous: CellStatus
    current: CellStatus


def key_of(cell: CoverageCellRow) -> CellKey:
    return cell.feature_id, cell.role, cell.interface_id


async def scenario_facts(
    session: AsyncSession, target_id: uuid.UUID, feature_ids: Collection[str]
) -> dict[CellKey, list[ScenarioFact]]:
    if not feature_ids:
        return {}
    rows = await session.execute(
        select(
            ScenarioRow.feature_id,
            SCENARIO_ROLE,
            SCENARIO_INTERFACE,
            ScenarioRow.status,
            ScenarioRow.provenance,
        ).where(
            ScenarioRow.target_id == target_id,
            ScenarioRow.feature_id.in_(list(feature_ids)),
            or_(
                ScenarioRow.parsed["synthetic"].is_(None),
                ScenarioRow.parsed["synthetic"].as_boolean().is_(False),
            ),
        )
    )
    facts: dict[CellKey, list[ScenarioFact]] = defaultdict(list)
    for feature_id, role, interface_id, status, provenance in rows:
        if feature_id is None or role is None or interface_id is None:
            continue
        facts[(feature_id, role, interface_id)].append(
            ScenarioFact(status=status, variant=variant_of(provenance))
        )
    return facts


async def sibling_role_counts(
    session: AsyncSession, plan_ids: Collection[uuid.UUID]
) -> dict[tuple[uuid.UUID, str, str], int]:
    if not plan_ids:
        return {}
    rows = await session.execute(
        select(
            CoverageCellRow.plan_id,
            CoverageCellRow.feature_id,
            CoverageCellRow.interface_id,
            func.count(),
        )
        .where(CoverageCellRow.plan_id.in_(list(plan_ids)))
        .group_by(CoverageCellRow.plan_id, CoverageCellRow.feature_id, CoverageCellRow.interface_id)
    )
    return {
        (plan_id, feature_id, interface_id): count
        for plan_id, feature_id, interface_id, count in rows
    }


def other_roles_of(siblings: dict[tuple[uuid.UUID, str, str], int], cell: CoverageCellRow) -> int:
    return max(siblings.get((cell.plan_id, cell.feature_id, cell.interface_id), 1) - 1, 0)


async def load_plans(
    session: AsyncSession, plan_ids: Collection[uuid.UUID]
) -> dict[uuid.UUID, PlanRow]:
    rows = await session.scalars(select(PlanRow).where(PlanRow.id.in_(list(plan_ids))))
    return {row.id: row for row in rows}


async def cells_for_keys(
    session: AsyncSession, target_id: uuid.UUID, keys: Collection[CellKey]
) -> list[CoverageCellRow]:
    if not keys:
        return []
    rows = await session.scalars(
        select(CoverageCellRow)
        .join(PlanRow, PlanRow.id == CoverageCellRow.plan_id)
        .where(
            PlanRow.target_id == target_id,
            tuple_(
                CoverageCellRow.feature_id, CoverageCellRow.role, CoverageCellRow.interface_id
            ).in_(list(keys)),
        )
        .order_by(CoverageCellRow.id)
        .with_for_update(of=CoverageCellRow)
    )
    return list(rows)


async def settle_cells(session: AsyncSession, cells: Sequence[CoverageCellRow]) -> list[CellChange]:
    if not cells:
        return []
    plans = await load_plans(session, {cell.plan_id for cell in cells})
    siblings = await sibling_role_counts(session, set(plans))
    features_by_target: dict[uuid.UUID, set[str]] = defaultdict(set)
    for cell in cells:
        features_by_target[plans[cell.plan_id].target_id].add(cell.feature_id)
    facts_by_target = {
        target_id: await scenario_facts(session, target_id, feature_ids)
        for target_id, feature_ids in features_by_target.items()
    }
    changes: list[CellChange] = []
    for cell in cells:
        plan = plans[cell.plan_id]
        facts = facts_by_target[plan.target_id].get(key_of(cell), [])
        previous = cell.status
        current = settled_status(previous, facts, plan.depth, other_roles_of(siblings, cell))
        cell.status = current
        if current in SETTLED_FROM_SCENARIOS or (
            previous in SETTLED_FROM_SCENARIOS and current is CellStatus.empty
        ):
            cell.reason = None
        changes.append(CellChange(plan.id, plan.target_id, cell.id, previous, current))
    await session.flush()
    return changes


async def settle_scenario_cells(
    session: AsyncSession, target_id: uuid.UUID, keys: Collection[CellKey]
) -> list[CellChange]:
    return await settle_cells(session, await cells_for_keys(session, target_id, keys))


async def settle_plan_cells(session: AsyncSession, plan_id: uuid.UUID) -> list[CellChange]:
    cells = await session.scalars(
        select(CoverageCellRow)
        .where(CoverageCellRow.plan_id == plan_id)
        .order_by(CoverageCellRow.id)
        .with_for_update()
    )
    return await settle_cells(session, list(cells))
