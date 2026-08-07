import asyncio
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BundleRow,
    CoverageCellRow,
    PromptIssueRow,
    ProposalItemRow,
    ProposalRow,
)
from tessa_api.db.models import Target as TargetRow
from tessa_api.errors import ApiError, not_found
from tessa_api.ids import new_id
from tessa_api.schemas.bundles import BundleValidationError
from tessa_api.schemas.catalog import Catalog
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import (
    AuditAction,
    AuditSubjectType,
    Depth,
    InterfaceMode,
    ProposalItemStatus,
    ProposalKind,
    ProposalNeed,
    ProposalOrigin,
)
from tessa_api.schemas.plans import CoverageCell, Plan, PlanCreate, PlanSelection
from tessa_api.schemas.proposals import (
    PROPOSAL_FILE,
    Proposal,
    ProposalEstimate,
    ProposalItem,
    ProposalItemReason,
    ProposalItemUpdate,
    ProposalPlanCreate,
    ProposalPut,
)
from tessa_api.schemas.streams import IngestEvent, ProposalUpdatedPayload
from tessa_api.services.audit import record_audit
from tessa_api.services.coverage import settled_baseline_plan
from tessa_api.services.plans import create_plan, latest_valid_bundle
from tessa_api.services.proposal_cells import (
    cells_by_feature,
    cells_for_item,
    item_ids_for_cell,
    items_by_feature,
    risk_by_feature,
    shown_status,
)
from tessa_api.services.proposal_import import (
    ProposalFileCheck,
    bundle_warnings,
    check_proposal_text,
    decode_proposal,
    effective_confidence,
)
from tessa_api.services.run_guard import ensure_bundle_usable
from tessa_api.services.scenario_import import AuthoredLink
from tessa_api.services.scenario_lifecycle import prompt_issue_for
from tessa_api.services.secret_scan import reject_secrets
from tessa_api.services.targets import get_active_target, get_target
from tessa_api.services.vault import Vault
from tessa_api.settings import Settings
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import event_envelope

PROPOSAL_UPDATED = "proposal.updated"
CARRIED_STATUSES = frozenset(
    {ProposalItemStatus.selected, ProposalItemStatus.declined, ProposalItemStatus.authored}
)
DEPTH_ORDER = {Depth.smoke: 0, Depth.standard: 1, Depth.deep: 2}
MAX_INVALID_DETAILS = 20


@dataclass(slots=True)
class ProposalImportOutcome:
    warnings: list[BundleValidationError] = field(default_factory=list)
    events: list[IngestEvent] = field(default_factory=list)


def proposal_updated_event(
    target_id: uuid.UUID,
    proposal_id: uuid.UUID,
    item_id: uuid.UUID | None,
    status: ProposalItemStatus | None,
) -> IngestEvent:
    payload = ProposalUpdatedPayload(
        target_id=target_id, proposal_id=proposal_id, item_id=item_id, status=status
    )
    return IngestEvent(
        type=PROPOSAL_UPDATED,
        payload=payload.model_dump(mode="json"),
        occurred_at=datetime.now(UTC),
        ephemeral=True,
    )


def publish_proposal_events(hub: Hub, events: Sequence[IngestEvent]) -> None:
    for event in events:
        hub.publish_ephemeral(event_envelope(None, event))


async def current_proposal_row(session: AsyncSession, target_id: uuid.UUID) -> ProposalRow | None:
    return await session.scalar(
        select(ProposalRow)
        .where(ProposalRow.target_id == target_id)
        .order_by(ProposalRow.created_at.desc(), ProposalRow.id.desc())
        .limit(1)
    )


async def load_items(session: AsyncSession, proposal_id: uuid.UUID) -> list[ProposalItemRow]:
    rows = await session.scalars(
        select(ProposalItemRow)
        .where(ProposalItemRow.proposal_id == proposal_id)
        .order_by(ProposalItemRow.position)
    )
    return list(rows)


async def current_items(session: AsyncSession, target_id: uuid.UUID) -> list[ProposalItemRow]:
    row = await current_proposal_row(session, target_id)
    return [] if row is None else await load_items(session, row.id)


async def baseline_cells(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    owner_id: uuid.UUID,
    refresh: bool = False,
) -> tuple[BundleRow | None, list[CoverageCellRow]]:
    latest = await latest_valid_bundle(session, target.id)
    if latest is None:
        return None, []
    plan = await settled_baseline_plan(session, settings, target, latest, owner_id, refresh)
    rows = await session.scalars(select(CoverageCellRow).where(CoverageCellRow.plan_id == plan.id))
    return latest, list(rows)


def to_proposal_item(row: ProposalItemRow, cells: Sequence[CoverageCellRow]) -> ProposalItem:
    return ProposalItem(
        id=row.id,
        key=row.key,
        title=row.title,
        area=row.area,
        feature_ids=list(row.feature_ids),
        interface_id=row.interface_id,
        kind=row.kind,
        risk=row.risk,
        reasons=[ProposalItemReason.model_validate(reason) for reason in row.reasons],
        needs=[ProposalNeed(need) for need in row.needs],
        depth=row.depth,
        estimate=ProposalEstimate.model_validate(row.estimate) if row.estimate else None,
        confidence=row.confidence,
        evidence=row.evidence,
        status=shown_status(row, cells),
        note=row.note,
        selected_by=row.selected_by,
        selected_at=row.selected_at,
        cell_ids=[cell.id for cell in cells],
        scenario_ids=[uuid.UUID(value) for value in row.scenario_ids],
    )


async def proposal_view(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    row: ProposalRow,
    owner_id: uuid.UUID,
    refresh: bool = False,
) -> Proposal:
    items = await load_items(session, row.id)
    latest, cells = await baseline_cells(session, settings, target, owner_id, refresh)
    by_feature = cells_by_feature(cells)
    return Proposal(
        id=row.id,
        target_id=row.target_id,
        bundle_id=row.bundle_id,
        commit_sha=row.commit_sha,
        branch=row.branch,
        generated_at=row.generated_at,
        source=row.source,
        created_by=row.created_by,
        created_at=row.created_at,
        stale=latest is not None and row.bundle_id != latest.id,
        items=[to_proposal_item(item, cells_for_item(item, by_feature)) for item in items],
    )


async def read_proposal(
    session: AsyncSession, settings: Settings, target_id: uuid.UUID, owner_id: uuid.UUID
) -> Proposal:
    target = await get_target(session, target_id)
    row = await current_proposal_row(session, target.id)
    if row is None:
        raise not_found("The target has no test proposal yet")
    view = await proposal_view(session, settings, target, row, owner_id, refresh=True)
    await session.commit()
    return view


def proposal_invalid(check: ProposalFileCheck) -> ApiError:
    details = [
        ErrorDetail(
            loc=["body", "yaml", *([error.pointer] if error.pointer else [])],
            code=error.code,
            message=(f"line {error.line}: " if error.line else "") + error.message,
        )
        for error in check.errors[:MAX_INVALID_DETAILS]
    ]
    return ApiError(
        422,
        "proposal_invalid",
        f"{PROPOSAL_FILE} is not valid: {len(check.errors)} error(s)",
        details,
    )


def target_tokens(target: TargetRow) -> list[str]:
    return [token for token in (target.target_token, target.previous_target_token) if token]


async def store_proposal(
    session: AsyncSession,
    target: TargetRow,
    bundle: BundleRow,
    check: ProposalFileCheck,
    origin: ProposalOrigin,
    user_id: uuid.UUID,
    prompt_issue_id: uuid.UUID | None,
) -> ProposalRow:
    doc = check.doc
    if doc is None:
        raise ValueError("a proposal can only be stored from a file that passed the check")
    now = datetime.now(UTC)
    previous = await current_proposal_row(session, target.id)
    carried = (
        {item.key: item for item in await load_items(session, previous.id)}
        if previous is not None
        else {}
    )
    source = doc.source
    row = ProposalRow(
        id=new_id(),
        target_id=target.id,
        bundle_id=bundle.id,
        prompt_issue_id=prompt_issue_id,
        commit_sha=source.commit if source is not None else bundle.commit_sha,
        branch=source.branch if source is not None else bundle.branch,
        generated_at=doc.generated_at or now,
        source=origin,
        created_by=user_id,
        created_at=now,
    )
    session.add(row)
    await session.flush()
    for position, item in enumerate(doc.items):
        earlier = carried.get(item.key)
        inherited = earlier if earlier is not None and earlier.status in CARRIED_STATUSES else None
        session.add(
            ProposalItemRow(
                id=new_id(),
                proposal_id=row.id,
                position=position,
                key=item.key,
                title=item.title,
                area=item.area,
                feature_ids=list(item.feature_ids),
                interface_id=item.interface_id,
                kind=item.kind,
                risk=item.risk,
                reasons=[reason.model_dump(mode="json") for reason in item.reasons],
                needs=[need.value for need in item.needs],
                depth=item.depth,
                estimate=item.estimate.model_dump(mode="json") if item.estimate else None,
                confidence=effective_confidence(
                    item.key, item.confidence, check.low_confidence_keys
                ),
                evidence=item.evidence,
                status=inherited.status if inherited is not None else ProposalItemStatus.proposed,
                note=inherited.note if inherited is not None else None,
                selected_by=inherited.selected_by if inherited is not None else None,
                selected_at=inherited.selected_at if inherited is not None else None,
                scenario_ids=list(inherited.scenario_ids) if inherited is not None else [],
            )
        )
    await session.flush()
    return row


async def put_proposal(
    session: AsyncSession,
    settings: Settings,
    hub: Hub,
    user_id: uuid.UUID,
    target_id: uuid.UUID,
    body: ProposalPut,
) -> Proposal:
    target = await get_active_target(session, target_id)
    bundle = ensure_bundle_usable(await latest_valid_bundle(session, target.id))
    await asyncio.to_thread(reject_secrets, {PROPOSAL_FILE: body.yaml.encode("utf-8")})
    check = check_proposal_text(body.yaml, bundle.manifest, target_tokens(target))
    if not check.usable or check.doc is None:
        raise proposal_invalid(check)
    issue_id = await prompt_issue_for(session, target.id, check.doc.authored_from)
    row = await store_proposal(
        session, target, bundle, check, ProposalOrigin.put, user_id, issue_id
    )
    await record_audit(
        session,
        user_id,
        AuditAction.proposal_put,
        AuditSubjectType.proposal,
        row.id,
        {"items": len(check.doc.items), "commit": row.commit_sha, "bundle_version": bundle.version},
    )
    view = await proposal_view(session, settings, target, row, user_id, refresh=True)
    await session.commit()
    publish_proposal_events(hub, [proposal_updated_event(target.id, row.id, None, None)])
    return view


async def import_bundle_proposal(
    session: AsyncSession,
    target: TargetRow,
    bundle: BundleRow,
    files: Mapping[str, bytes],
    user_id: uuid.UUID,
) -> ProposalImportOutcome:
    content = files.get(PROPOSAL_FILE)
    if content is None:
        return ProposalImportOutcome()
    check = check_proposal_text(decode_proposal(content), bundle.manifest, target_tokens(target))
    outcome = ProposalImportOutcome(warnings=bundle_warnings(check))
    if not check.usable or check.doc is None:
        return outcome
    issue_id = await prompt_issue_for(session, target.id, check.doc.authored_from)
    row = await store_proposal(
        session, target, bundle, check, ProposalOrigin.bundle, user_id, issue_id
    )
    outcome.events.append(proposal_updated_event(target.id, row.id, None, None))
    return outcome


def item_not_current() -> ApiError:
    return ApiError(
        409,
        "conflict",
        "The item belongs to an older proposal; reload the proposal of the target",
    )


def item_authored() -> ApiError:
    detail = ErrorDetail(
        loc=["body", "status"],
        code="item_authored",
        message="Scenarios were already authored for the item, so it can no longer be changed",
    )
    return ApiError(409, "conflict", "The item is already authored", [detail])


async def update_item(
    session: AsyncSession,
    settings: Settings,
    hub: Hub,
    user_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ProposalItemUpdate,
) -> ProposalItem:
    row = await session.get(ProposalItemRow, item_id, with_for_update=True)
    if row is None:
        raise not_found("Proposal item not found")
    proposal = await session.get(ProposalRow, row.proposal_id)
    if proposal is None:
        raise not_found("Proposal not found")
    current = await current_proposal_row(session, proposal.target_id)
    if current is None or current.id != proposal.id:
        raise item_not_current()
    if row.status is ProposalItemStatus.authored:
        raise item_authored()
    previous = row.status
    row.status = ProposalItemStatus(body.status.value)
    if "note" in body.model_fields_set:
        row.note = body.note.strip() if body.note and body.note.strip() else None
    elif row.status is ProposalItemStatus.proposed:
        row.note = None
    if row.status is ProposalItemStatus.proposed:
        row.selected_by = None
        row.selected_at = None
    else:
        row.selected_by = user_id
        row.selected_at = datetime.now(UTC)
    await record_audit(
        session,
        user_id,
        AuditAction.proposal_item_changed,
        AuditSubjectType.proposal,
        row.id,
        {"item": row.key, "from": previous.value, "to": row.status.value},
    )
    target = await get_target(session, proposal.target_id)
    _, cells = await baseline_cells(session, settings, target, user_id)
    view = to_proposal_item(row, cells_for_item(row, cells_by_feature(cells)))
    await session.commit()
    publish_proposal_events(
        hub, [proposal_updated_event(target.id, proposal.id, row.id, row.status)]
    )
    return view


def interface_mode_of(items: Sequence[ProposalItemRow]) -> InterfaceMode:
    browser = any(item.kind is ProposalKind.browser for item in items)
    other = any(item.kind is not ProposalKind.browser for item in items)
    if browser and other:
        return InterfaceMode.both
    return InterfaceMode.browser_only if browser else InterfaceMode.api_only


def selection_of(items: Sequence[ProposalItemRow]) -> PlanSelection:
    return PlanSelection(
        feature_ids=sorted({feature_id for item in items for feature_id in item.feature_ids}),
        area_ids=[],
        roles=[],
        interface_mode=interface_mode_of(items),
        depth=max((item.depth for item in items), key=DEPTH_ORDER.__getitem__),
        k=1,
        budget=None,
    )


def nothing_to_plan() -> ApiError:
    detail = ErrorDetail(
        loc=["body", "item_ids"],
        code="nothing_selected",
        message="Select at least one item of the proposal before planning",
    )
    return ApiError(422, "validation_failed", "Request validation failed", [detail])


def unknown_items(missing: Sequence[uuid.UUID]) -> ApiError:
    details = [
        ErrorDetail(
            loc=["body", "item_ids"],
            code="item_not_found",
            message=f"Item {item_id} is not part of the current proposal",
        )
        for item_id in missing
    ]
    return ApiError(422, "validation_failed", "Request validation failed", details)


def chosen_items(
    items: Sequence[ProposalItemRow], wanted: Sequence[uuid.UUID] | None
) -> list[ProposalItemRow]:
    if wanted is None:
        return [item for item in items if item.status is ProposalItemStatus.selected]
    by_id = {item.id: item for item in items}
    missing = [item_id for item_id in dict.fromkeys(wanted) if item_id not in by_id]
    if missing:
        raise unknown_items(missing)
    return [by_id[item_id] for item_id in dict.fromkeys(wanted)]


async def plan_from_proposal(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    user_id: uuid.UUID,
    target_id: uuid.UUID,
    body: ProposalPlanCreate,
) -> Plan:
    target = await get_active_target(session, target_id)
    current = await current_proposal_row(session, target.id)
    if current is None:
        raise not_found("The target has no test proposal yet")
    chosen = chosen_items(await load_items(session, current.id), body.item_ids)
    if not chosen:
        raise nothing_to_plan()
    name = body.name or f"Proposal {datetime.now(UTC).date().isoformat()}"
    create = PlanCreate(
        target_id=target.id,
        bundle_id=None,
        name=name,
        saved=True,
        selection=selection_of(chosen),
        include_api_fuzz=False,
    )
    plan = await create_plan(session, settings, vault, user_id, create)
    await session.commit()
    return plan


async def annotate_coverage(
    session: AsyncSession, target_id: uuid.UUID, cells: list[CoverageCell]
) -> list[CoverageCell]:
    items = await current_items(session, target_id)
    if not items:
        return cells
    by_feature = items_by_feature(items)
    return [
        cell.model_copy(
            update={
                "proposal_item_ids": item_ids_for_cell(
                    by_feature, cell.feature_id, cell.interface_id
                )
            }
        )
        for cell in cells
    ]


async def annotate_catalog(
    session: AsyncSession, target_id: uuid.UUID, catalog: Catalog
) -> Catalog:
    items = await current_items(session, target_id)
    if not items:
        return catalog
    risks = risk_by_feature(items)
    for area in catalog.areas:
        for item in area.items:
            item.proposal_risk = risks.get(item.feature_id)
    return catalog


def scenario_belongs_to_item(item: ProposalItemRow, link: AuthoredLink) -> bool:
    if link.feature_id is None or link.feature_id not in item.feature_ids:
        return False
    return item.interface_id is None or item.interface_id == link.interface_id


def referenced_item_ids(issue: PromptIssueRow) -> list[uuid.UUID]:
    raw = issue.params.get("proposal_item_ids")
    found: list[uuid.UUID] = []
    for value in raw if isinstance(raw, list) else []:
        try:
            found.append(uuid.UUID(str(value)))
        except ValueError:
            continue
    return found


async def link_authored_scenarios(
    session: AsyncSession, target_id: uuid.UUID, links: Sequence[AuthoredLink]
) -> list[IngestEvent]:
    if not links:
        return []
    issues = await session.scalars(
        select(PromptIssueRow).where(
            PromptIssueRow.id.in_(list({link.prompt_issue_id for link in links})),
            PromptIssueRow.target_id == target_id,
        )
    )
    item_ids_by_issue = {issue.id: referenced_item_ids(issue) for issue in issues}
    wanted = {item_id for ids in item_ids_by_issue.values() for item_id in ids}
    current = await current_proposal_row(session, target_id)
    if not wanted or current is None:
        return []
    referenced = await session.scalars(
        select(ProposalItemRow).where(ProposalItemRow.id.in_(list(wanted)))
    )
    keys = {row.id: row.key for row in referenced}
    current_by_key = {item.key: item for item in await load_items(session, current.id)}
    touched: dict[uuid.UUID, ProposalItemRow] = {}
    for link in links:
        for item_id in item_ids_by_issue.get(link.prompt_issue_id, ()):
            key = keys.get(item_id)
            item = current_by_key.get(key) if key is not None else None
            if item is None or not scenario_belongs_to_item(item, link):
                continue
            if str(link.scenario_id) not in item.scenario_ids:
                item.scenario_ids = [*item.scenario_ids, str(link.scenario_id)]
            if item.status in (ProposalItemStatus.proposed, ProposalItemStatus.selected):
                item.status = ProposalItemStatus.authored
            touched[item.id] = item
    return [
        proposal_updated_event(target_id, current.id, item.id, item.status)
        for item in touched.values()
    ]
