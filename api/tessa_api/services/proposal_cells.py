import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence

from tessa_api.db.models import CoverageCellRow, ProposalItemRow
from tessa_api.schemas.enums import CellStatus, ProposalItemStatus, ProposalRisk

RISK_ORDER: Mapping[ProposalRisk, int] = {
    ProposalRisk.low: 0,
    ProposalRisk.medium: 1,
    ProposalRisk.high: 2,
}


def cells_by_feature(cells: Iterable[CoverageCellRow]) -> dict[str, list[CoverageCellRow]]:
    grouped: dict[str, list[CoverageCellRow]] = defaultdict(list)
    for cell in cells:
        grouped[cell.feature_id].append(cell)
    return grouped


def item_matches_interface(item: ProposalItemRow, interface_id: str) -> bool:
    return item.interface_id is None or item.interface_id == interface_id


def cells_for_item(
    item: ProposalItemRow, by_feature: Mapping[str, Sequence[CoverageCellRow]]
) -> list[CoverageCellRow]:
    found: dict[uuid.UUID, CoverageCellRow] = {}
    for feature_id in item.feature_ids:
        for cell in by_feature.get(feature_id, ()):
            if item_matches_interface(item, cell.interface_id):
                found[cell.id] = cell
    return sorted(found.values(), key=lambda cell: (cell.feature_id, cell.role, cell.interface_id))


def shown_status(item: ProposalItemRow, cells: Sequence[CoverageCellRow]) -> ProposalItemStatus:
    if item.status is ProposalItemStatus.declined:
        return ProposalItemStatus.declined
    if cells and all(cell.status is CellStatus.covered for cell in cells):
        return ProposalItemStatus.covered
    return item.status


def items_by_feature(items: Iterable[ProposalItemRow]) -> dict[str, list[ProposalItemRow]]:
    grouped: dict[str, list[ProposalItemRow]] = defaultdict(list)
    for item in items:
        if item.status is ProposalItemStatus.declined:
            continue
        for feature_id in item.feature_ids:
            grouped[feature_id].append(item)
    return grouped


def risk_by_feature(items: Iterable[ProposalItemRow]) -> dict[str, ProposalRisk]:
    risks: dict[str, ProposalRisk] = {}
    for feature_id, grouped in items_by_feature(items).items():
        risks[feature_id] = max((item.risk for item in grouped), key=RISK_ORDER.__getitem__)
    return risks


def item_ids_for_cell(
    by_feature: Mapping[str, Sequence[ProposalItemRow]], feature_id: str, interface_id: str
) -> list[uuid.UUID]:
    return [
        item.id
        for item in by_feature.get(feature_id, ())
        if item_matches_interface(item, interface_id)
    ]
