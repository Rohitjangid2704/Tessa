import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import replace

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BundleRow,
    CoverageCellRow,
    PlanRow,
    ProposalItemRow,
    ProposalRow,
    ScenarioRow,
)
from tessa_api.db.models import Target as TargetRow
from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import CellStatus
from tessa_api.schemas.prompts import AUTHOR_PROMPT_MAX_CELLS
from tessa_api.services.cell_rules import LIVE_SCENARIO_STATUSES, CellKey
from tessa_api.services.coverage import settled_baseline_plan
from tessa_api.services.plans import latest_valid_bundle
from tessa_api.services.prompts.author import (
    MAX_LISTED_TITLES,
    AuthorCell,
    AuthorInputs,
    AuthorItem,
    AuthorVocabulary,
)
from tessa_api.services.proposal_cells import cells_by_feature, cells_for_item
from tessa_api.services.run_guard import ensure_bundle_usable
from tessa_api.services.scenario_library import scenario_view_for_bundle
from tessa_api.services.scenario_validator import ScenarioBundleView, mapping_items
from tessa_api.settings import Settings

SCENARIO_ROLE = ScenarioRow.parsed["role"].astext
SCENARIO_INTERFACE = ScenarioRow.parsed["interface_id"].astext


def cell_problem(position: int, code: str, message: str) -> ErrorDetail:
    return ErrorDetail(loc=["body", "cell_ids", position], code=code, message=message)


def validation_failed(details: list[ErrorDetail]) -> ApiError:
    return ApiError(422, "validation_failed", "Request validation failed", details)


def key_of(row: CoverageCellRow) -> CellKey:
    return row.feature_id, row.role, row.interface_id


async def load_cells(
    session: AsyncSession, target_id: uuid.UUID, cell_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, CoverageCellRow]:
    rows = await session.scalars(
        select(CoverageCellRow)
        .join(PlanRow, PlanRow.id == CoverageCellRow.plan_id)
        .where(CoverageCellRow.id.in_(list(cell_ids)), PlanRow.target_id == target_id)
    )
    return {row.id: row for row in rows}


def problem_of(
    position: int, row: CoverageCellRow | None, view: ScenarioBundleView
) -> ErrorDetail | None:
    if row is None:
        return cell_problem(position, "cell_not_found", "The cell does not exist for this target")
    if row.status is CellStatus.blocked:
        return cell_problem(
            position, "cell_blocked", row.reason or "The cell is blocked and cannot be authored"
        )
    reach = view.features.get(row.feature_id)
    known = (
        reach is not None
        and row.role in view.role_ids
        and row.interface_id in view.interface_kinds
        and row.role in reach.role_ids
        and row.interface_id in reach.interface_ids
    )
    if not known:
        return cell_problem(
            position,
            "cell_not_in_bundle",
            "The cell is not part of the latest valid bundle; open the coverage page again",
        )
    return None


def select_cells(
    cell_ids: Sequence[uuid.UUID],
    stored: Mapping[uuid.UUID, CoverageCellRow],
    view: ScenarioBundleView,
) -> list[CoverageCellRow]:
    details: list[ErrorDetail] = []
    chosen: dict[CellKey, CoverageCellRow] = {}
    for position, cell_id in enumerate(cell_ids):
        row = stored.get(cell_id)
        problem = problem_of(position, row, view)
        if problem is not None:
            details.append(problem)
        elif row is not None:
            chosen.setdefault(key_of(row), row)
    if details:
        raise validation_failed(details)
    return list(chosen.values())


async def load_existing_titles(
    session: AsyncSession, target_id: uuid.UUID, feature_ids: Sequence[str]
) -> dict[CellKey, list[str]]:
    rows = await session.execute(
        select(ScenarioRow.feature_id, SCENARIO_ROLE, SCENARIO_INTERFACE, ScenarioRow.title)
        .where(
            ScenarioRow.target_id == target_id,
            ScenarioRow.feature_id.in_(list(feature_ids)),
            ScenarioRow.status.in_(list(LIVE_SCENARIO_STATUSES)),
            or_(
                ScenarioRow.parsed["synthetic"].is_(None),
                ScenarioRow.parsed["synthetic"].as_boolean().is_(False),
            ),
        )
        .order_by(ScenarioRow.created_at, ScenarioRow.id)
    )
    titles: dict[CellKey, list[str]] = defaultdict(list)
    for feature_id, role, interface_id, title in rows:
        if feature_id is not None and role is not None and interface_id is not None:
            titles[(feature_id, role, interface_id)].append(title)
    return titles


def feature_summaries(bundle: BundleRow) -> dict[str, str]:
    features = (bundle.manifest or {}).get("features")
    return {
        str(feature["id"]): str(feature.get("description") or "")
        for feature in mapping_items(features)
        if "id" in feature
    }


def to_author_cell(
    row: CoverageCellRow,
    view: ScenarioBundleView,
    summaries: Mapping[str, str],
    titles: Mapping[CellKey, Sequence[str]],
) -> AuthorCell:
    reach = view.features[row.feature_id]
    existing = list(titles.get(key_of(row), ()))
    return AuthorCell(
        cell_id=row.id,
        feature_id=row.feature_id,
        role=row.role,
        interface_id=row.interface_id,
        interface_kind=view.interface_kinds[row.interface_id].value,
        status=row.status,
        reason=row.reason,
        feature_kind=reach.kind.value if reach.kind is not None else None,
        feature_summary=summaries.get(row.feature_id, ""),
        writes_data=reach.writes,
        cleanup_declared=reach.cleanup_declared,
        existing_titles=tuple(existing[:MAX_LISTED_TITLES]),
        existing_total=len(existing),
    )


def to_author_vocabulary(view: ScenarioBundleView) -> AuthorVocabulary:
    vocabulary = view.vocabulary()
    return AuthorVocabulary(
        role_ids=vocabulary.role_ids,
        interfaces=tuple(
            (interface_id, view.interface_kinds[interface_id].value)
            for interface_id in vocabulary.interface_ids
        ),
        feature_ids=vocabulary.feature_ids,
        oracle_names=vocabulary.oracle_names,
        tool_names=vocabulary.tool_names,
        environment_names=tuple(sorted(view.environment_names)),
    )


def item_problem(position: int, code: str, message: str) -> ErrorDetail:
    return ErrorDetail(loc=["body", "proposal_item_ids", position], code=code, message=message)


async def load_target_items(
    session: AsyncSession, target_id: uuid.UUID, item_ids: Sequence[uuid.UUID]
) -> list[ProposalItemRow]:
    rows = await session.scalars(
        select(ProposalItemRow)
        .join(ProposalRow, ProposalRow.id == ProposalItemRow.proposal_id)
        .where(ProposalItemRow.id.in_(list(item_ids)), ProposalRow.target_id == target_id)
    )
    by_id = {row.id: row for row in rows}
    details = [
        item_problem(
            position,
            "proposal_item_not_found",
            "The item does not belong to a proposal of this target",
        )
        for position, item_id in enumerate(item_ids)
        if item_id not in by_id
    ]
    if details:
        raise validation_failed(details)
    return [by_id[item_id] for item_id in dict.fromkeys(item_ids)]


async def authorable_cell_ids(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    bundle: BundleRow,
    owner_id: uuid.UUID,
    items: Sequence[ProposalItemRow],
) -> list[uuid.UUID]:
    plan = await settled_baseline_plan(session, settings, target, bundle, owner_id, refresh=True)
    cells = await session.scalars(select(CoverageCellRow).where(CoverageCellRow.plan_id == plan.id))
    by_feature = cells_by_feature(cells)
    chosen: dict[uuid.UUID, CoverageCellRow] = {}
    for item in items:
        for cell in cells_for_item(item, by_feature):
            if cell.status is not CellStatus.blocked:
                chosen[cell.id] = cell
    if not chosen:
        raise validation_failed(
            [
                item_problem(
                    0,
                    "item_has_no_authorable_cells",
                    "The items map to no cell that can be authored: the features are not in the "
                    "latest valid bundle or every cell is blocked",
                )
            ]
        )
    if len(chosen) > AUTHOR_PROMPT_MAX_CELLS:
        raise validation_failed(
            [
                item_problem(
                    0,
                    "too_many_cells",
                    f"The items map to {len(chosen)} cells and one Author prompt takes at most "
                    f"{AUTHOR_PROMPT_MAX_CELLS}; tick fewer items",
                )
            ]
        )
    return list(chosen)


def to_author_item(row: ProposalItemRow) -> AuthorItem:
    return AuthorItem(
        title=row.title,
        risk=row.risk.value,
        depth=row.depth.value,
        reasons=tuple(
            f"{reason['code']}: {reason['note']}" if reason.get("note") else str(reason["code"])
            for reason in row.reasons
        ),
        needs=tuple(row.needs),
        feature_ids=tuple(row.feature_ids),
        evidence=row.evidence,
    )


async def load_author_inputs_for_items(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    item_ids: Sequence[uuid.UUID],
    issue_id: uuid.UUID,
    owner_id: uuid.UUID,
) -> tuple[AuthorInputs, BundleRow]:
    bundle = ensure_bundle_usable(await latest_valid_bundle(session, target.id))
    items = await load_target_items(session, target.id, item_ids)
    cell_ids = await authorable_cell_ids(session, settings, target, bundle, owner_id, items)
    inputs, bundle = await load_author_inputs(session, target, cell_ids, issue_id)
    return replace(inputs, items=tuple(to_author_item(item) for item in items)), bundle


async def load_author_inputs(
    session: AsyncSession,
    target: TargetRow,
    cell_ids: Sequence[uuid.UUID],
    issue_id: uuid.UUID,
) -> tuple[AuthorInputs, BundleRow]:
    bundle = ensure_bundle_usable(await latest_valid_bundle(session, target.id))
    view = await scenario_view_for_bundle(session, target.id, bundle.id)
    stored = await load_cells(session, target.id, cell_ids)
    chosen = select_cells(cell_ids, stored, view)
    titles = await load_existing_titles(
        session, target.id, sorted({row.feature_id for row in chosen})
    )
    summaries = feature_summaries(bundle)
    inputs = AuthorInputs(
        issue_id=issue_id,
        bundle_version=bundle.version,
        cells=tuple(to_author_cell(row, view, summaries, titles) for row in chosen),
        vocabulary=to_author_vocabulary(view),
    )
    return inputs, bundle
