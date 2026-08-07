import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BundleRow,
    PromptIssueRow,
    RunRow,
    RunScenarioRow,
    ScenarioProvenanceRow,
    ScenarioRow,
    ScenarioVersionRow,
)
from tessa_api.db.models import Target as TargetRow
from tessa_api.errors import ApiError, not_found
from tessa_api.ids import new_id
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import (
    CoverageUpdateReason,
    ReviewDecision,
    ScenarioOrigin,
    ScenarioPatchStatus,
    ScenarioStatus,
)
from tessa_api.schemas.scenario import ScenarioDoc
from tessa_api.schemas.scenarios import (
    ScenarioCreate,
    ScenarioDryRun,
    ScenarioGenerator,
    ScenarioIssue,
    ScenarioProvenance,
    ScenarioValidation,
    ScenarioVersion,
    ScenarioVersionPage,
)
from tessa_api.schemas.streams import IngestEvent
from tessa_api.services.cell_rules import CellKey
from tessa_api.services.cell_status import CellChange, settle_scenario_cells
from tessa_api.services.coverage import resolve_cell
from tessa_api.services.coverage_events import coverage_updated_events, scenario_changed_event
from tessa_api.services.flakiness import provenance_after_release
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.plans import latest_valid_bundle
from tessa_api.services.run_guard import ACTIVE_RUN_STATUSES, ensure_bundle_usable
from tessa_api.services.scenario_library import (
    get_scenario_row,
    is_synthetic,
    scenario_view_for_bundle,
    status_after_validation,
)
from tessa_api.services.scenario_records import provenance_row, version_row
from tessa_api.services.scenario_validator import ScenarioCheck, validate_scenario_text
from tessa_api.services.targets import get_active_target, get_target
from tessa_api.settings import Settings

AUTHORED_KEY = "authored_key"
REVIEW_KEY = "review"
BODY_YAML_LOCATION: tuple[str | int, ...] = ("body", "yaml")
STATUSES_RESET_BY_EDIT = frozenset(
    {
        ScenarioStatus.draft,
        ScenarioStatus.validating,
        ScenarioStatus.invalid,
        ScenarioStatus.rejected,
    }
)
KEPT_ON_REIMPORT = frozenset({ScenarioStatus.retired, ScenarioStatus.quarantined})
RETIRABLE_STATUSES = frozenset(
    {
        ScenarioStatus.draft,
        ScenarioStatus.validating,
        ScenarioStatus.invalid,
        ScenarioStatus.in_review,
        ScenarioStatus.accepted,
        ScenarioStatus.rejected,
        ScenarioStatus.quarantined,
    }
)
PATCH_SOURCES: Mapping[ScenarioPatchStatus, frozenset[ScenarioStatus]] = {
    ScenarioPatchStatus.retired: RETIRABLE_STATUSES,
    ScenarioPatchStatus.quarantined: frozenset({ScenarioStatus.accepted}),
    ScenarioPatchStatus.accepted: frozenset(
        {
            ScenarioStatus.in_review,
            ScenarioStatus.rejected,
            ScenarioStatus.quarantined,
            ScenarioStatus.retired,
        }
    ),
}
PATCH_TARGETS: Mapping[ScenarioPatchStatus, ScenarioStatus] = {
    ScenarioPatchStatus.retired: ScenarioStatus.retired,
    ScenarioPatchStatus.quarantined: ScenarioStatus.quarantined,
    ScenarioPatchStatus.accepted: ScenarioStatus.accepted,
}
VERSION_COLUMNS: dict[str, SortableColumn] = {
    "version": sortable(ScenarioVersionRow.version, int),
}
VERSION_TIEBREAK = sortable(ScenarioVersionRow.scenario_id, uuid.UUID)


@dataclass(frozen=True, slots=True)
class BundleCheck:
    bundle: BundleRow
    check: ScenarioCheck


@dataclass(frozen=True, slots=True)
class ValidScenario:
    text: str
    document: ScenarioDoc
    parsed: dict[str, Any]
    validation: ScenarioValidation


@dataclass(frozen=True, slots=True)
class ProvenanceInput:
    finding_id: uuid.UUID | None = None
    ticket_url: str | None = None
    prompt_issue_id: uuid.UUID | None = None
    generator: Mapping[str, Any] | None = None
    details: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class NewScenario:
    bundle: BundleRow
    valid: ValidScenario
    origin: ScenarioOrigin
    created_by: uuid.UUID | None
    cell_id: uuid.UUID | None = None
    status: ScenarioStatus | None = None
    note: str | None = None
    provenance: ProvenanceInput = field(default_factory=ProvenanceInput)


@dataclass(slots=True)
class ScenarioWrite:
    row: ScenarioRow
    changes: list[CellChange]


def pointer_location(pointer: str | None) -> list[str | int]:
    if not pointer:
        return []
    return [int(part) if part.isdigit() else part for part in pointer.strip("/").split("/") if part]


def issue_message(issue: ScenarioIssue) -> str:
    where = f" (line {issue.line}, column {issue.column})" if issue.line is not None else ""
    return f"{issue.message}{where}"


def invalid_scenario_error(validation: ScenarioValidation) -> ApiError:
    details = [
        ErrorDetail(
            loc=[*BODY_YAML_LOCATION, *pointer_location(issue.pointer)],
            code=issue.code,
            message=issue_message(issue),
        )
        for issue in validation.errors
    ]
    return ApiError(422, "validation_failed", "The scenario is not valid", details)


def conflict_error(
    message: str, loc: Sequence[str | int], code: str, detail_message: str
) -> ApiError:
    return ApiError(
        409, "conflict", message, [ErrorDetail(loc=list(loc), code=code, message=detail_message)]
    )


def transition_error(status: ScenarioStatus, wanted: str, loc: str) -> ApiError:
    return conflict_error(
        f"A scenario that is {status.value} cannot be moved to {wanted}",
        ["body", loc],
        "transition_not_allowed",
        f"Moving from {status.value} to {wanted} is not allowed",
    )


def version_conflict_error(current: int, base: int) -> ApiError:
    return ApiError(
        409,
        "version_conflict",
        "The scenario changed since you opened it; reload it and apply your edit again",
        [
            ErrorDetail(
                loc=["body", "base_version"],
                code="version_conflict",
                message=f"The scenario is at version {current}, the edit started from {base}",
            )
        ],
    )


async def check_against_bundle(
    session: AsyncSession, bundle: BundleRow, text: str
) -> ScenarioCheck:
    view = await scenario_view_for_bundle(session, bundle.target_id, bundle.id)
    return validate_scenario_text(text, view)


async def check_for_target(session: AsyncSession, target_id: uuid.UUID, text: str) -> BundleCheck:
    target = await get_target(session, target_id)
    bundle = ensure_bundle_usable(await latest_valid_bundle(session, target.id))
    return BundleCheck(bundle, await check_against_bundle(session, bundle, text))


def require_valid(text: str, check: ScenarioCheck) -> ValidScenario:
    if not check.validation.valid or check.document is None or check.parsed is None:
        raise invalid_scenario_error(check.validation)
    return ValidScenario(text, check.document, check.parsed, check.validation)


def cell_key_of(row: ScenarioRow) -> CellKey | None:
    if row.feature_id is None:
        return None
    return row.feature_id, str(row.parsed.get("role", "")), str(row.parsed.get("interface_id", ""))


def keys_of(*candidates: CellKey | None) -> list[CellKey]:
    return list(dict.fromkeys(key for key in candidates if key is not None))


def document_key(valid: ValidScenario) -> CellKey | None:
    document = valid.document
    if document.feature_id is None:
        return None
    return document.feature_id, document.role, document.interface_id


async def ensure_key_free(
    session: AsyncSession, target_id: uuid.UUID, key: str, own_id: uuid.UUID | None
) -> None:
    holder = await find_by_authored_key(session, target_id, key)
    if holder is not None and holder.id != own_id:
        raise conflict_error(
            f"Another scenario of this target already uses the id {key!r}",
            BODY_YAML_LOCATION,
            "duplicate_scenario_id",
            f"The scenario id {key!r} belongs to scenario {holder.id}",
        )


async def find_by_authored_key(
    session: AsyncSession, target_id: uuid.UUID, key: str
) -> ScenarioRow | None:
    return await session.scalar(
        select(ScenarioRow).where(
            ScenarioRow.target_id == target_id,
            ScenarioRow.provenance[AUTHORED_KEY].astext == key,
        )
    )


def provenance_blob(new: NewScenario) -> dict[str, Any] | None:
    blob: dict[str, Any] = dict(new.provenance.details)
    if new.provenance.generator is not None:
        blob["generator"] = dict(new.provenance.generator)
    if AUTHORED_KEY not in blob and new.valid.document.id is not None:
        blob[AUTHORED_KEY] = new.valid.document.id
    return blob or None


async def create_scenario_row(session: AsyncSession, new: NewScenario) -> ScenarioWrite:
    blob = provenance_blob(new)
    key = blob.get(AUTHORED_KEY) if blob is not None else None
    if isinstance(key, str):
        await ensure_key_free(session, new.bundle.target_id, key, None)
    document = new.valid.document
    row = ScenarioRow(
        id=new_id(),
        target_id=new.bundle.target_id,
        bundle_id=new.bundle.id,
        feature_id=document.feature_id,
        cell_id=new.cell_id,
        title=document.title,
        family=document.family,
        origin=new.origin,
        status=new.status or status_after_validation(new.origin, ScenarioStatus.validating, True),
        version=1,
        yaml=new.valid.text,
        parsed=new.valid.parsed,
        validation=new.valid.validation.model_dump(mode="json"),
        provenance=blob,
    )
    session.add(row)
    await session.flush()
    session.add(version_row(row, new.created_by, new.note))
    session.add(
        provenance_row(
            row,
            new.bundle,
            new.provenance.finding_id,
            new.provenance.ticket_url,
            new.provenance.prompt_issue_id,
            new.provenance.generator,
        )
    )
    await session.flush()
    changes = await settle_scenario_cells(session, row.target_id, keys_of(document_key(new.valid)))
    await session.refresh(row)
    return ScenarioWrite(row, changes)


def status_after_edit(origin: ScenarioOrigin, current: ScenarioStatus) -> ScenarioStatus:
    if current in STATUSES_RESET_BY_EDIT:
        return status_after_validation(origin, ScenarioStatus.validating, True)
    return current


async def scenario_in_active_run(session: AsyncSession, scenario_id: uuid.UUID) -> bool:
    found = await session.scalar(
        select(RunScenarioRow.id)
        .join(RunRow, RunRow.id == RunScenarioRow.run_id)
        .where(RunScenarioRow.scenario_id == scenario_id, RunRow.status.in_(ACTIVE_RUN_STATUSES))
        .limit(1)
    )
    return found is not None


async def ensure_editable(session: AsyncSession, row: ScenarioRow) -> None:
    if is_synthetic(row):
        raise conflict_error(
            "Tessa manages synthetic scenarios itself; they cannot be edited",
            BODY_YAML_LOCATION,
            "synthetic_scenario",
            "The scenario is synthetic",
        )
    if await scenario_in_active_run(session, row.id):
        raise conflict_error(
            "The scenario is part of a run in progress; edit it when the run has finished",
            BODY_YAML_LOCATION,
            "scenario_in_active_run",
            "A run that executes this version is still active",
        )


def reject_synthetic_document(valid: ValidScenario) -> None:
    if valid.document.synthetic:
        raise ApiError(
            422,
            "validation_failed",
            "Request validation failed",
            [
                ErrorDetail(
                    loc=[*BODY_YAML_LOCATION, "synthetic"],
                    code="synthetic_not_allowed",
                    message="Synthetic scenarios are created by Tessa, not by clients",
                )
            ],
        )


async def authored_key_after_edit(
    session: AsyncSession, row: ScenarioRow, valid: ValidScenario
) -> dict[str, Any] | None:
    blob = dict(row.provenance) if row.provenance else {}
    current = blob.get(AUTHORED_KEY)
    wanted = valid.document.id
    if wanted is None or wanted == current:
        return blob or None
    if isinstance(current, str):
        raise ApiError(
            422,
            "validation_failed",
            "The id of an authored scenario cannot change",
            [
                ErrorDetail(
                    loc=[*BODY_YAML_LOCATION, "id"],
                    code="authored_id_changed",
                    message=f"The scenario id is {current!r} and cannot become {wanted!r}",
                )
            ],
        )
    await ensure_key_free(session, row.target_id, wanted, row.id)
    blob[AUTHORED_KEY] = wanted
    return blob


async def apply_new_version(
    session: AsyncSession,
    row: ScenarioRow,
    bundle: BundleRow,
    valid: ValidScenario,
    created_by: uuid.UUID | None,
    note: str | None,
    cell_id: uuid.UUID | None,
    blob: dict[str, Any] | None,
    status: ScenarioStatus | None = None,
) -> ScenarioWrite:
    document = valid.document
    previous_key = cell_key_of(row)
    row.version += 1
    row.bundle_id = bundle.id
    row.feature_id = document.feature_id
    row.cell_id = cell_id
    row.title = document.title
    row.family = document.family
    row.yaml = valid.text
    row.parsed = valid.parsed
    row.validation = valid.validation.model_dump(mode="json")
    row.provenance = blob
    row.embedding = None
    row.status = status or status_after_edit(row.origin, row.status)
    await session.flush()
    session.add(version_row(row, created_by, note))
    await session.flush()
    keys = keys_of(previous_key, document_key(valid))
    changes = await settle_scenario_cells(session, row.target_id, keys)
    await session.refresh(row)
    return ScenarioWrite(row, changes)


async def locked_scenario(session: AsyncSession, scenario_id: uuid.UUID) -> ScenarioRow:
    row = await session.get(ScenarioRow, scenario_id, with_for_update=True)
    if row is None:
        raise not_found("Scenario not found")
    return row


async def prompt_issue_for(
    session: AsyncSession, target_id: uuid.UUID, issue_id: uuid.UUID | None
) -> uuid.UUID | None:
    if issue_id is None:
        return None
    return await session.scalar(
        select(PromptIssueRow.id).where(
            PromptIssueRow.id == issue_id, PromptIssueRow.target_id == target_id
        )
    )


async def create_from_yaml(
    session: AsyncSession, settings: Settings, user_id: uuid.UUID, body: ScenarioCreate
) -> ScenarioWrite:
    target = await get_active_target(session, body.target_id)
    bundle = ensure_bundle_usable(await latest_valid_bundle(session, target.id))
    valid = require_valid(body.yaml, await check_against_bundle(session, bundle, body.yaml))
    reject_synthetic_document(valid)
    cell = await resolve_cell(
        session,
        settings,
        target,
        bundle,
        valid.document.feature_id,
        valid.document.role,
        valid.document.interface_id,
        user_id,
    )
    issue_id = await prompt_issue_for(session, target.id, valid.document.authored_from)
    return await create_scenario_row(
        session,
        NewScenario(
            bundle=bundle,
            valid=valid,
            origin=ScenarioOrigin.manual,
            created_by=user_id,
            cell_id=cell.id if cell is not None else None,
            provenance=ProvenanceInput(prompt_issue_id=issue_id),
        ),
    )


async def resolve_edit_cell(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    bundle: BundleRow,
    valid: ValidScenario,
    owner_id: uuid.UUID,
) -> uuid.UUID | None:
    document = valid.document
    cell = await resolve_cell(
        session,
        settings,
        target,
        bundle,
        document.feature_id,
        document.role,
        document.interface_id,
        owner_id,
    )
    return cell.id if cell is not None else None


async def update_scenario(
    session: AsyncSession,
    settings: Settings,
    user_id: uuid.UUID,
    scenario_id: uuid.UUID,
    text: str,
    base_version: int,
    note: str | None = None,
) -> ScenarioWrite:
    row = await locked_scenario(session, scenario_id)
    if row.version != base_version:
        raise version_conflict_error(row.version, base_version)
    if text == row.yaml:
        return ScenarioWrite(row, [])
    await ensure_editable(session, row)
    target = await get_active_target(session, row.target_id)
    bundle = ensure_bundle_usable(await latest_valid_bundle(session, target.id))
    valid = require_valid(text, await check_against_bundle(session, bundle, text))
    reject_synthetic_document(valid)
    blob = await authored_key_after_edit(session, row, valid)
    cell_id = await resolve_edit_cell(session, settings, target, bundle, valid, user_id)
    return await apply_new_version(session, row, bundle, valid, user_id, note, cell_id, blob)


async def upsert_authored_scenario(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    bundle: BundleRow,
    authored_key: str,
    valid: ValidScenario,
    created_by: uuid.UUID,
    provenance: ProvenanceInput,
    note: str | None = None,
) -> tuple[ScenarioWrite, str]:
    cell = await resolve_edit_cell(session, settings, target, bundle, valid, created_by)
    return await upsert_authored_in_cell(
        session, target, bundle, cell, authored_key, valid, created_by, provenance, note
    )


async def upsert_authored_in_cell(
    session: AsyncSession,
    target: TargetRow,
    bundle: BundleRow,
    cell: uuid.UUID | None,
    authored_key: str,
    valid: ValidScenario,
    created_by: uuid.UUID,
    provenance: ProvenanceInput,
    note: str | None = None,
) -> tuple[ScenarioWrite, str]:
    existing = await find_by_authored_key(session, target.id, authored_key)
    if existing is None:
        details = {**provenance.details, AUTHORED_KEY: authored_key}
        created = await create_scenario_row(
            session,
            NewScenario(
                bundle=bundle,
                valid=valid,
                origin=ScenarioOrigin.authored,
                created_by=created_by,
                cell_id=cell,
                status=ScenarioStatus.validating,
                note=note,
                provenance=ProvenanceInput(
                    finding_id=provenance.finding_id,
                    ticket_url=provenance.ticket_url,
                    prompt_issue_id=provenance.prompt_issue_id,
                    generator=provenance.generator,
                    details=details,
                ),
            ),
        )
        return created, "created"
    locked = await locked_scenario(session, existing.id)
    if locked.yaml == valid.text:
        return ScenarioWrite(locked, []), "unchanged"
    await ensure_editable(session, locked)
    blob = {**(locked.provenance or {}), **provenance.details, AUTHORED_KEY: authored_key}
    keeps_status = locked.status in KEPT_ON_REIMPORT
    versioned = await apply_new_version(
        session,
        locked,
        bundle,
        valid,
        created_by,
        note,
        cell,
        blob,
        locked.status if keeps_status else ScenarioStatus.validating,
    )
    return versioned, "versioned"


def review_blob(
    row: ScenarioRow, decision: ReviewDecision, note: str | None, user_id: uuid.UUID
) -> dict[str, Any]:
    blob = dict(row.provenance) if row.provenance else {}
    blob[REVIEW_KEY] = {
        "decision": decision.value,
        "note": note,
        "by": str(user_id),
        "at": datetime.now(UTC).isoformat(),
    }
    return blob


async def review_scenario(
    session: AsyncSession,
    user_id: uuid.UUID,
    scenario_id: uuid.UUID,
    decision: ReviewDecision,
    note: str | None,
) -> ScenarioWrite:
    row = await locked_scenario(session, scenario_id)
    outcome = (
        ScenarioStatus.accepted if decision is ReviewDecision.accept else ScenarioStatus.rejected
    )
    if row.status is not ScenarioStatus.in_review:
        raise transition_error(row.status, outcome.value, "decision")
    row.status = outcome
    row.provenance = review_blob(row, decision, note, user_id)
    await session.flush()
    changes = await settle_scenario_cells(session, row.target_id, keys_of(cell_key_of(row)))
    await session.refresh(row)
    return ScenarioWrite(row, changes)


async def patch_scenario_status(
    session: AsyncSession, scenario_id: uuid.UUID, wanted: ScenarioPatchStatus
) -> ScenarioWrite:
    row = await locked_scenario(session, scenario_id)
    outcome = PATCH_TARGETS[wanted]
    if row.status is outcome:
        return ScenarioWrite(row, [])
    if row.status not in PATCH_SOURCES[wanted] or is_synthetic(row):
        raise transition_error(row.status, outcome.value, "status")
    if row.status is ScenarioStatus.quarantined and outcome is ScenarioStatus.accepted:
        row.provenance = provenance_after_release(row.provenance, datetime.now(UTC))
    row.status = outcome
    await session.flush()
    changes = await settle_scenario_cells(session, row.target_id, keys_of(cell_key_of(row)))
    await session.refresh(row)
    return ScenarioWrite(row, changes)


def merge_warnings(
    existing: Sequence[Mapping[str, Any]], extra: Sequence[ScenarioIssue]
) -> list[dict[str, Any]]:
    merged = [dict(item) for item in existing]
    seen = {(item.get("code"), item.get("pointer"), item.get("message")) for item in merged}
    for issue in extra:
        identity = (issue.code, issue.pointer, issue.message)
        if identity not in seen:
            seen.add(identity)
            merged.append(issue.model_dump(mode="json"))
    return merged


async def provenance_row_for(session: AsyncSession, row: ScenarioRow) -> ScenarioProvenanceRow:
    found = await session.scalar(
        select(ScenarioProvenanceRow)
        .where(ScenarioProvenanceRow.scenario_id == row.id)
        .with_for_update()
    )
    if found is not None:
        return found
    bundle = await session.get(BundleRow, row.bundle_id)
    if bundle is None:
        raise not_found("Bundle of the scenario not found")
    created = provenance_row(row, bundle)
    session.add(created)
    await session.flush()
    return created


async def complete_dry_runs(
    session: AsyncSession,
    scenario_id: uuid.UUID,
    dry_runs: Sequence[ScenarioDryRun],
    warnings: Sequence[ScenarioIssue] = (),
) -> ScenarioWrite:
    row = await locked_scenario(session, scenario_id)
    provenance = await provenance_row_for(session, row)
    provenance.dry_runs = [
        *provenance.dry_runs,
        *(entry.model_dump(mode="json") for entry in dry_runs),
    ]
    validation = dict(row.validation)
    validation["warnings"] = merge_warnings(validation.get("warnings") or [], warnings)
    row.validation = validation
    if row.status in (ScenarioStatus.draft, ScenarioStatus.validating):
        row.status = status_after_validation(row.origin, row.status, True)
    await session.flush()
    changes = await settle_scenario_cells(session, row.target_id, keys_of(cell_key_of(row)))
    await session.refresh(row)
    return ScenarioWrite(row, changes)


def to_scenario_generator(raw: Any) -> ScenarioGenerator | None:
    if not isinstance(raw, Mapping):
        return None
    try:
        return ScenarioGenerator.model_validate(raw)
    except ValueError:
        return None


def to_dry_runs(raw: Sequence[Mapping[str, Any]]) -> list[ScenarioDryRun]:
    entries: list[ScenarioDryRun] = []
    for item in raw:
        try:
            entries.append(ScenarioDryRun.model_validate(item))
        except ValueError:
            continue
    return entries


async def read_provenance(session: AsyncSession, scenario_id: uuid.UUID) -> ScenarioProvenance:
    row = await get_scenario_row(session, scenario_id)
    stored = await session.scalar(
        select(ScenarioProvenanceRow).where(ScenarioProvenanceRow.scenario_id == scenario_id)
    )
    if stored is not None:
        return ScenarioProvenance(
            cell_id=stored.cell_id,
            bundle_id=stored.bundle_id,
            bundle_version=stored.bundle_version,
            finding_id=stored.finding_id,
            ticket_url=stored.ticket_url,
            prompt_issue_id=stored.prompt_issue_id,
            generator=to_scenario_generator(stored.generator),
            dry_runs=to_dry_runs(stored.dry_runs),
            created_at=stored.created_at,
        )
    bundle = await session.get(BundleRow, row.bundle_id)
    legacy = row.provenance.get("generator") if row.provenance else None
    return ScenarioProvenance(
        cell_id=row.cell_id,
        bundle_id=row.bundle_id,
        bundle_version=bundle.version if bundle is not None else 1,
        finding_id=None,
        ticket_url=None,
        prompt_issue_id=None,
        generator=to_scenario_generator(legacy),
        dry_runs=[],
        created_at=row.created_at,
    )


def to_scenario_version(row: ScenarioVersionRow) -> ScenarioVersion:
    return ScenarioVersion(
        scenario_id=row.scenario_id,
        version=row.version,
        yaml=row.yaml,
        parsed=row.parsed,
        created_by=row.created_by,
        created_at=row.created_at,
        note=row.note,
    )


async def list_versions(
    session: AsyncSession, scenario_id: uuid.UUID, query: PageQuery
) -> ScenarioVersionPage:
    await get_scenario_row(session, scenario_id)
    page = await paginate(
        session,
        select(ScenarioVersionRow).where(ScenarioVersionRow.scenario_id == scenario_id),
        VERSION_COLUMNS,
        VERSION_TIEBREAK,
        query,
    )
    return ScenarioVersionPage(
        items=[to_scenario_version(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def load_pinned_version(
    session: AsyncSession, scenario_id: uuid.UUID, version: int
) -> ScenarioVersionRow | None:
    return await session.get(ScenarioVersionRow, (scenario_id, version))


def lifecycle_events(write: ScenarioWrite, reason: CoverageUpdateReason) -> list[IngestEvent]:
    return [
        scenario_changed_event(write.row.id, write.row.status, write.row.cell_id),
        *coverage_updated_events(write.changes, reason),
    ]
