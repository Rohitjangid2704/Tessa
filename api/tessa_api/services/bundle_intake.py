import asyncio
import hashlib
import logging
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, BinaryIO

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, Target, User
from tessa_api.errors import ApiError
from tessa_api.schemas.bundle import BUNDLE_SCHEMA_VERSION, BundleManifest, EnvironmentVariable
from tessa_api.schemas.bundles import BundleValidationError
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import BundleSourceKind, BundleValidationStatus
from tessa_api.schemas.proposals import PROPOSAL_FILE
from tessa_api.services.bundle_archive import ArchiveLimits, extract_archive
from tessa_api.services.bundle_differ import BundleSnapshot, DiffResult, diff_bundles
from tessa_api.services.bundle_scorer import score_bundle
from tessa_api.services.bundle_validator import BundleAnalysis, validate_bundle
from tessa_api.services.catalog_builder import catalog_rows
from tessa_api.services.env_template import ParsedEnvTemplate
from tessa_api.services.environment import DeclaredVariable, reconcile_environment
from tessa_api.services.manifest_loader import MANIFEST_FILE, LoadedManifest, load_manifest
from tessa_api.services.mutant_import import (
    MUTANTS_FILE,
    import_mutants,
    mutants_file_present,
)
from tessa_api.services.proposals import import_bundle_proposal, link_authored_scenarios
from tessa_api.services.scenario_import import (
    SCENARIO_FOLDER,
    ScenarioImport,
    api_cell_resolver,
    import_authored_scenarios,
    scenario_paths,
)
from tessa_api.services.secret_scan import reject_secrets
from tessa_api.services.storage import BundleStore, StagedBundle, sha256_hex
from tessa_api.services.target_token import find_target_by_token
from tessa_api.services.targets import get_target
from tessa_api.services.truth_import import import_truth
from tessa_api.settings import Settings

logger = logging.getLogger("tessa_api.bundle_intake")

LOCK_STATEMENT = text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))")
LOCK_KEY_PREFIX = "bundle-intake:"
MAX_DETAILS = 20
ARCHIVE_SOURCES = frozenset({BundleSourceKind.zip})


@dataclass(frozen=True)
class IntakeResult:
    row: BundleRow
    created: bool
    imported: ScenarioImport = field(default_factory=ScenarioImport)


@dataclass(frozen=True)
class PreparedFiles:
    files: dict[str, bytes]
    warnings: list[BundleValidationError]


def normalise_pasted_text(manifest_yaml: str) -> bytes:
    cleaned = manifest_yaml.removeprefix("﻿").replace("\r\n", "\n").replace("\r", "\n")
    return cleaned.encode("utf-8")


async def prepare_files(
    settings: Settings,
    source: BundleSourceKind,
    archive: BinaryIO | None,
    manifest_yaml: str | None,
) -> PreparedFiles:
    if source in ARCHIVE_SOURCES and archive is not None:
        extracted = await asyncio.to_thread(
            extract_archive, archive, ArchiveLimits.from_settings(settings)
        )
        return PreparedFiles(extracted.files, extracted.warnings)
    if manifest_yaml is None:
        raise ApiError(400, "bad_request", "Nothing to ingest")
    return PreparedFiles({MANIFEST_FILE: normalise_pasted_text(manifest_yaml)}, [])


def bundle_hash(files: Mapping[str, bytes]) -> str:
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(path.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(sha256_hex(files[path]).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def missing_manifest_error() -> BundleValidationError:
    return BundleValidationError(
        code="manifest_missing",
        message="The archive has no manifest.yaml at its root or under tessa/",
        severity="error",
        file=MANIFEST_FILE,
        pointer=None,
        line=None,
        column=None,
    )


def load_bundle_manifest(files: Mapping[str, bytes], max_bytes: int) -> LoadedManifest:
    content = files.get(MANIFEST_FILE)
    if content is None:
        return LoadedManifest(file=MANIFEST_FILE, errors=[missing_manifest_error()])
    return load_manifest(content.decode("utf-8", errors="replace"), max_bytes)


def token_error(code: str, message: str) -> ApiError:
    detail = ErrorDetail(loc=["manifest", "target_token"], code=code, message=message)
    return ApiError(422, code, message, [detail])


async def resolve_target(
    session: AsyncSession, loaded: LoadedManifest, target_id: uuid.UUID | None
) -> tuple[Target, bool]:
    if loaded.target_token is not None:
        match = await find_target_by_token(session, loaded.target_token)
        if match is None:
            raise token_error(
                "target_token_unknown",
                "The target_token in manifest.yaml does not belong to any target; copy it from "
                "the Discovery prompt of the target",
            )
        if target_id is not None and match.target.id != target_id:
            raise ApiError(
                409,
                "target_token_mismatch",
                "The target_token in manifest.yaml belongs to a different target than target_id",
                [
                    ErrorDetail(
                        loc=["form", "target_id"],
                        code="target_token_mismatch",
                        message="target_id does not match the manifest target_token",
                    )
                ],
            )
        target, rotated = match.target, match.matched_previous
    elif target_id is not None:
        target, rotated = await get_target(session, target_id), False
    else:
        raise token_error(
            "target_token_unknown",
            "manifest.yaml has no target_token and no target_id was given, so the bundle cannot "
            "be matched to a target",
        )
    if target.archived_at is not None:
        raise ApiError(409, "conflict", "This target is archived")
    return target, rotated


def rotated_token_warning() -> BundleValidationError:
    return BundleValidationError(
        code="target_token_rotated",
        message="manifest.yaml carries the previous target_token; use the current one from the "
        "latest Discovery or Fix-up prompt",
        severity="warning",
        file=MANIFEST_FILE,
        pointer="/target_token",
        line=None,
        column=None,
    )


async def find_by_hash(
    session: AsyncSession, target_id: uuid.UUID, content_hash: str
) -> BundleRow | None:
    return await session.scalar(
        select(BundleRow).where(BundleRow.target_id == target_id, BundleRow.hash == content_hash)
    )


def file_entries(files: Mapping[str, bytes]) -> list[dict[str, Any]]:
    return [
        {"path": path, "size_bytes": len(files[path]), "sha256": sha256_hex(files[path])}
        for path in sorted(files)
    ]


def stored_manifest(analysis: BundleAnalysis) -> dict[str, Any] | None:
    if analysis.manifest is not None:
        dumped: dict[str, Any] = analysis.manifest.model_dump(mode="json", by_alias=True)
        return dumped
    return analysis.data


def source_of(analysis: BundleAnalysis) -> tuple[str | None, str | None]:
    source = analysis.manifest.source if analysis.manifest is not None else None
    return (source.commit, source.branch) if source is not None else (None, None)


def count_features(manifest: Mapping[str, Any] | None) -> int:
    features = (manifest or {}).get("features")
    return len(features) if isinstance(features, list) else 0


def declared_purpose(variable: EnvironmentVariable, template: ParsedEnvTemplate | None) -> str:
    if variable.purpose:
        return variable.purpose
    entry = template.entries.get(variable.name) if template is not None else None
    return (entry.purpose or "") if entry is not None else ""


def declared_variables(
    manifest: BundleManifest, template: ParsedEnvTemplate | None
) -> list[DeclaredVariable]:
    declared = [
        DeclaredVariable(
            name=variable.name,
            kind=variable.kind.value,
            secret=variable.secret,
            required=variable.required,
            purpose=declared_purpose(variable, template),
            interfaces=tuple(variable.interfaces),
        )
        for variable in manifest.environment
    ]
    if template is not None:
        known = {variable.name for variable in manifest.environment}
        declared.extend(
            DeclaredVariable(name=entry.name, required=False, purpose=entry.purpose or "")
            for entry in template.entries.values()
            if entry.name not in known
        )
    return declared


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


def snapshot_of(
    manifest: Mapping[str, Any] | None, entries: Sequence[Mapping[str, Any]]
) -> BundleSnapshot:
    return BundleSnapshot(manifest=manifest, files=entries)


def compute_diff(
    current_manifest: Mapping[str, Any] | None,
    entries: Sequence[Mapping[str, Any]],
    base: BundleRow | None,
) -> tuple[DiffResult, dict[str, Any] | None]:
    if base is None:
        return diff_bundles(snapshot_of(current_manifest, entries), None), None
    result = diff_bundles(
        snapshot_of(current_manifest, entries),
        snapshot_of(base.manifest, base.files),
        base.version,
    )
    summary = result.to_summary(base.id, base.version).model_dump(mode="json")
    return result, summary


def scenarios_not_imported_warning(path: str) -> BundleValidationError:
    return BundleValidationError(
        code="scenarios_not_imported",
        message="The bundle has validation errors, so its scenario files were not imported; "
        "fix the errors and upload again",
        severity="warning",
        file=path,
        pointer=None,
        line=None,
        column=None,
    )


async def import_scenarios(
    session: AsyncSession,
    settings: Settings,
    row: BundleRow,
    target: Target,
    user: User,
    files: Mapping[str, bytes],
    analysis: BundleAnalysis,
) -> ScenarioImport:
    if not analysis.valid:
        if scenario_paths(files):
            row.warnings = [
                *row.warnings,
                scenarios_not_imported_warning(SCENARIO_FOLDER.rstrip("/")).model_dump(mode="json"),
            ]
        return ScenarioImport()
    imported = await import_authored_scenarios(
        session, target, row, files, user.id, api_cell_resolver(settings, target, row, user.id)
    )
    row.scenarios_imported = len(imported.imported)
    row.warnings = [*row.warnings, *(item.model_dump(mode="json") for item in imported.warnings)]
    return imported


def proposal_not_imported_warning() -> BundleValidationError:
    return BundleValidationError(
        code="proposal_not_imported",
        message="The bundle has validation errors, so its proposal file was not imported; fix "
        "the errors and upload again",
        severity="warning",
        file=PROPOSAL_FILE,
        pointer=None,
        line=None,
        column=None,
    )


def proposal_store_failed_warning() -> BundleValidationError:
    return BundleValidationError(
        code="proposal_not_imported",
        message="The proposal could not be stored because of a server error; the bundle itself "
        "was kept, upload it again to retry",
        severity="warning",
        file=PROPOSAL_FILE,
        pointer=None,
        line=None,
        column=None,
    )


async def import_proposal_isolated(
    session: AsyncSession,
    row: BundleRow,
    target: Target,
    user: User,
    files: Mapping[str, bytes],
    imported: ScenarioImport,
) -> None:
    try:
        async with session.begin_nested():
            outcome = await import_bundle_proposal(session, target, row, files, user.id)
    except Exception:
        logger.exception("proposal_import_failed", extra={"bundle_id": str(row.id)})
        row.warnings = [*row.warnings, proposal_store_failed_warning().model_dump(mode="json")]
        return
    row.warnings = [*row.warnings, *(item.model_dump(mode="json") for item in outcome.warnings)]
    imported.events.extend(outcome.events)


async def link_authored_isolated(
    session: AsyncSession, row: BundleRow, target: Target, imported: ScenarioImport
) -> None:
    if not imported.authored_links:
        return
    try:
        async with session.begin_nested():
            events = await link_authored_scenarios(session, target.id, imported.authored_links)
    except Exception:
        logger.exception("proposal_link_failed", extra={"bundle_id": str(row.id)})
        return
    imported.events.extend(events)


async def settle_proposals(
    session: AsyncSession,
    row: BundleRow,
    target: Target,
    user: User,
    files: Mapping[str, bytes],
    analysis: BundleAnalysis,
    imported: ScenarioImport,
) -> None:
    if PROPOSAL_FILE in files:
        if analysis.valid:
            await import_proposal_isolated(session, row, target, user, files, imported)
        else:
            row.warnings = [*row.warnings, proposal_not_imported_warning().model_dump(mode="json")]
    if analysis.valid:
        await link_authored_isolated(session, row, target, imported)


def mutants_not_imported_warning() -> BundleValidationError:
    return BundleValidationError(
        code="mutants_not_imported",
        message="The bundle has validation errors, so its mutants file was not imported; fix "
        "the errors and upload again",
        severity="warning",
        file=MUTANTS_FILE,
        pointer=None,
        line=None,
        column=None,
    )


async def register_mutants(
    session: AsyncSession,
    settings: Settings,
    row: BundleRow,
    target: Target,
    user: User,
    files: Mapping[str, bytes],
    analysis: BundleAnalysis,
) -> None:
    if not mutants_file_present(files):
        return
    if not analysis.valid or analysis.manifest is None:
        row.warnings = [*row.warnings, mutants_not_imported_warning().model_dump(mode="json")]
        return
    registered = await import_mutants(session, settings, target, analysis.manifest, files, user.id)
    row.mutants_imported = len(registered.imported)
    row.warnings = [*row.warnings, *(item.model_dump(mode="json") for item in registered.warnings)]


async def persist_bundle(
    session: AsyncSession,
    settings: Settings,
    store: BundleStore,
    staged: StagedBundle,
    user: User,
    target: Target,
    source: BundleSourceKind,
    note: str | None,
    content_hash: str,
    files: Mapping[str, bytes],
    analysis: BundleAnalysis,
    completeness: dict[str, Any],
    warnings: Sequence[BundleValidationError],
) -> IntakeResult:
    await session.execute(LOCK_STATEMENT, {"key": f"{LOCK_KEY_PREFIX}{target.id}"})
    existing = await find_by_hash(session, target.id, content_hash)
    if existing is not None:
        await store.discard(staged)
        return IntakeResult(existing, created=False)
    highest = await session.scalar(
        select(func.max(BundleRow.version)).where(BundleRow.target_id == target.id)
    )
    version = (highest or 0) + 1
    manifest = stored_manifest(analysis)
    entries = file_entries(files)
    _, diff_summary = compute_diff(manifest, entries, await latest_valid_bundle(session, target.id))
    source_commit, source_branch = source_of(analysis)
    storage_path = await store.commit(staged, version)
    imported = ScenarioImport()
    try:
        row = BundleRow(
            target_id=target.id,
            version=version,
            hash=content_hash,
            source=source,
            note=note,
            schema_version=BUNDLE_SCHEMA_VERSION,
            validation_status=(
                BundleValidationStatus.valid if analysis.valid else BundleValidationStatus.invalid
            ),
            errors=[error.model_dump(mode="json") for error in analysis.errors],
            warnings=[warning.model_dump(mode="json") for warning in warnings],
            completeness=completeness,
            diff_summary=diff_summary,
            manifest=manifest,
            feature_count=count_features(manifest),
            file_count=len(files),
            size_bytes=sum(len(content) for content in files.values()),
            files=entries,
            storage_path=storage_path,
            uploaded_by=user.id,
            commit_sha=source_commit,
            branch=source_branch,
        )
        session.add(row)
        await session.flush()
        if analysis.valid and analysis.manifest is not None:
            session.add_all(catalog_rows(row.id, manifest or {}))
            await reconcile_environment(
                session, target.id, declared_variables(analysis.manifest, analysis.env_template)
            )
            await import_truth(session, row, analysis.manifest, files)
        imported = await import_scenarios(session, settings, row, target, user, files, analysis)
        await register_mutants(session, settings, row, target, user, files, analysis)
        await settle_proposals(session, row, target, user, files, analysis, imported)
        await session.commit()
    except BaseException:
        await store.remove(storage_path)
        raise
    await session.refresh(row)
    return IntakeResult(row, created=True, imported=imported)


async def intake_bundle(
    session: AsyncSession,
    settings: Settings,
    store: BundleStore,
    user: User,
    source: BundleSourceKind,
    target_id: uuid.UUID | None,
    note: str | None,
    archive: BinaryIO | None = None,
    manifest_yaml: str | None = None,
) -> IntakeResult:
    prepared = await prepare_files(settings, source, archive, manifest_yaml)
    return await intake_bundle_files(
        session,
        settings,
        store,
        user,
        source,
        target_id,
        note,
        prepared.files,
        prepared.warnings,
    )


async def intake_bundle_files(
    session: AsyncSession,
    settings: Settings,
    store: BundleStore,
    user: User,
    source: BundleSourceKind,
    target_id: uuid.UUID | None,
    note: str | None,
    files: Mapping[str, bytes],
    warnings: Sequence[BundleValidationError] = (),
) -> IntakeResult:
    await asyncio.to_thread(reject_secrets, files)
    loaded = load_bundle_manifest(files, settings.bundle_max_manifest_bytes)
    if loaded.data is None and target_id is None:
        first = loaded.errors[0]
        raise ApiError(
            422,
            "validation_failed",
            f"{first.message}; fix it, or upload with a target_id to keep the bundle for review",
            [
                ErrorDetail(loc=["file", error.file], code=error.code, message=error.message)
                for error in loaded.errors[:MAX_DETAILS]
            ],
        )
    target, rotated = await resolve_target(session, loaded, target_id)
    content_hash = bundle_hash(files)
    existing = await find_by_hash(session, target.id, content_hash)
    if existing is not None:
        return IntakeResult(existing, created=False)
    analysis = await asyncio.to_thread(
        validate_bundle,
        loaded,
        files,
        source is not BundleSourceKind.manifest_paste,
        settings.bundle_max_manifest_bytes,
    )
    completeness = score_bundle(analysis, settings.bundle_completeness_bar)
    all_warnings = [*warnings, *analysis.warnings]
    if rotated:
        all_warnings.append(rotated_token_warning())
    staged = await store.stage(target.id, files)
    try:
        return await persist_bundle(
            session,
            settings,
            store,
            staged,
            user,
            target,
            source,
            note,
            content_hash,
            files,
            analysis,
            completeness.model_dump(mode="json"),
            all_warnings,
        )
    except BaseException:
        await store.discard(staged)
        raise
