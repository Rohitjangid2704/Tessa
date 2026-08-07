import asyncio
import uuid
from collections.abc import Mapping, Sequence
from typing import BinaryIO

from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.schemas.bundles import (
    BundleDiffSummary,
    BundleValidationError,
    BundleValidationReport,
    FixupItem,
)
from tessa_api.schemas.enums import BundleSourceKind, BundleValidationStatus
from tessa_api.schemas.proposals import PROPOSAL_FILE
from tessa_api.services.bundle_intake import (
    compute_diff,
    count_features,
    file_entries,
    latest_valid_bundle,
    load_bundle_manifest,
    prepare_files,
    resolve_target,
    rotated_token_warning,
    source_of,
    stored_manifest,
)
from tessa_api.services.bundle_scorer import score_bundle
from tessa_api.services.bundle_validator import validate_bundle
from tessa_api.services.bundle_views import hooks_missing
from tessa_api.services.fixup_items import FixupItem as FixupItemRow
from tessa_api.services.fixup_items import build_fixup_items
from tessa_api.services.proposal_import import (
    ProposalFileCheck,
    bundle_warnings,
    check_proposal_text,
    decode_proposal,
)
from tessa_api.services.proposals import target_tokens
from tessa_api.services.secret_scan import reject_secrets
from tessa_api.settings import Settings


def to_fixup_item(item: FixupItemRow) -> FixupItem:
    return FixupItem(
        kind=item.kind, location=item.location, message=item.message, fix_hint=item.fix_hint
    )


def dumped(problems: Sequence[BundleValidationError]) -> list[dict[str, object]]:
    return [problem.model_dump(mode="json") for problem in problems]


def check_bundle_proposal(
    files: Mapping[str, bytes], manifest: Mapping[str, object] | None, tokens: Sequence[str]
) -> ProposalFileCheck | None:
    content = files.get(PROPOSAL_FILE)
    if content is None:
        return None
    return check_proposal_text(decode_proposal(content), manifest, tokens)


async def validate_bundle_files(
    session: AsyncSession,
    settings: Settings,
    files: Mapping[str, bytes],
    extraction_warnings: Sequence[BundleValidationError],
    target_id: uuid.UUID | None,
) -> BundleValidationReport:
    await asyncio.to_thread(reject_secrets, files)
    loaded = load_bundle_manifest(files, settings.bundle_max_manifest_bytes)
    target = None
    rotated = False
    if loaded.target_token is not None or target_id is not None:
        target, rotated = await resolve_target(session, loaded, target_id)
    analysis = await asyncio.to_thread(
        validate_bundle, loaded, files, True, settings.bundle_max_manifest_bytes
    )
    completeness = score_bundle(analysis, settings.bundle_completeness_bar)
    warnings = [*extraction_warnings, *analysis.warnings]
    if rotated:
        warnings.append(rotated_token_warning())
    manifest = stored_manifest(analysis)
    proposal = check_bundle_proposal(
        files, manifest, target_tokens(target) if target is not None else []
    )
    if proposal is not None:
        warnings.extend(bundle_warnings(proposal))
    diff_summary: BundleDiffSummary | None = None
    if target is not None:
        base = await latest_valid_bundle(session, target.id)
        _, summary = compute_diff(manifest, file_entries(files), base)
        diff_summary = BundleDiffSummary.model_validate(summary) if summary is not None else None
    commit_sha, branch = source_of(analysis)
    fixup_items = build_fixup_items(
        dumped(analysis.errors), dumped(warnings), completeness.model_dump(mode="json")
    )
    return BundleValidationReport(
        validation_status=(
            BundleValidationStatus.valid if analysis.valid else BundleValidationStatus.invalid
        ),
        errors=analysis.errors,
        warnings=warnings,
        completeness=completeness,
        diff_summary=diff_summary,
        fixup_items=[to_fixup_item(item) for item in fixup_items],
        hooks_missing=hooks_missing(manifest),
        feature_count=count_features(manifest),
        file_count=len(files),
        size_bytes=sum(len(content) for content in files.values()),
        commit_sha=commit_sha,
        branch=branch,
        proposal=proposal.as_check() if proposal is not None else None,
    )


async def validate_bundle_archive(
    session: AsyncSession,
    settings: Settings,
    archive: BinaryIO,
    target_id: uuid.UUID | None,
) -> BundleValidationReport:
    prepared = await prepare_files(settings, BundleSourceKind.zip, archive, None)
    return await validate_bundle_files(
        session, settings, prepared.files, prepared.warnings, target_id
    )
