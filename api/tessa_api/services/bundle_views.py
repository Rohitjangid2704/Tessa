import uuid
from collections.abc import Mapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow
from tessa_api.errors import ApiError, not_found
from tessa_api.schemas.bundles import (
    Bundle,
    BundleCompleteness,
    BundleDiff,
    BundleDiffSummary,
    BundleFileContent,
    BundleHookMissing,
    BundleSummary,
    BundleValidationError,
)
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import BundleValidationStatus
from tessa_api.services.bundle_differ import BundleSnapshot, diff_bundles
from tessa_api.services.storage import BundleStore

MAX_PREVIEW_BYTES = 1024 * 1024


def hooks_missing(manifest: Mapping[str, Any] | None) -> list[BundleHookMissing]:
    hooks = (manifest or {}).get("test_hooks")
    missing = hooks.get("missing") if isinstance(hooks, Mapping) else None
    return [
        BundleHookMissing(id=str(hook["id"]), description=str(hook.get("description", "")))
        for hook in (missing if isinstance(missing, list) else [])
        if isinstance(hook, Mapping) and "id" in hook
    ]


def to_bundle(row: BundleRow) -> Bundle:
    return Bundle(
        id=row.id,
        target_id=row.target_id,
        version=row.version,
        hash=row.hash,
        source=row.source,
        note=row.note,
        schema_version=row.schema_version,
        uploaded_by=row.uploaded_by,
        uploaded_at=row.uploaded_at,
        validation_status=row.validation_status,
        errors=[BundleValidationError.model_validate(error) for error in row.errors],
        warnings=[BundleValidationError.model_validate(warning) for warning in row.warnings],
        completeness=BundleCompleteness.model_validate(row.completeness),
        diff_summary=(
            BundleDiffSummary.model_validate(row.diff_summary)
            if row.diff_summary is not None
            else None
        ),
        feature_count=row.feature_count,
        file_count=row.file_count,
        size_bytes=row.size_bytes,
        hooks_missing=hooks_missing(row.manifest),
        scenarios_imported=row.scenarios_imported,
        mutants_imported=row.mutants_imported,
        commit_sha=row.commit_sha,
        branch=row.branch,
    )


def to_bundle_summary(row: BundleRow) -> BundleSummary:
    completeness = BundleCompleteness.model_validate(row.completeness)
    return BundleSummary(
        id=row.id,
        version=row.version,
        hash=row.hash,
        source=row.source,
        validation_status=row.validation_status,
        completeness_score=completeness.score,
        completeness_status=completeness.status,
        feature_count=row.feature_count,
        uploaded_at=row.uploaded_at,
    )


async def previous_valid_bundle(session: AsyncSession, bundle: BundleRow) -> BundleRow | None:
    return await session.scalar(
        select(BundleRow)
        .where(
            BundleRow.target_id == bundle.target_id,
            BundleRow.version < bundle.version,
            BundleRow.validation_status == BundleValidationStatus.valid,
        )
        .order_by(BundleRow.version.desc())
        .limit(1)
    )


async def resolve_diff_base(
    session: AsyncSession, bundle: BundleRow, against: uuid.UUID | None
) -> BundleRow | None:
    if against is None:
        return await previous_valid_bundle(session, bundle)
    base = await session.get(BundleRow, against)
    if base is None:
        raise not_found("The bundle to compare with does not exist")
    if base.target_id != bundle.target_id:
        raise ApiError(
            422,
            "validation_failed",
            "The bundles belong to different targets and cannot be compared",
            [
                ErrorDetail(
                    loc=["query", "against"],
                    code="bundle_not_comparable",
                    message="against must be a version of the same target",
                )
            ],
        )
    return base


async def build_bundle_diff(
    session: AsyncSession, bundle: BundleRow, against: uuid.UUID | None
) -> BundleDiff:
    base = await resolve_diff_base(session, bundle, against)
    current = BundleSnapshot(manifest=bundle.manifest, files=bundle.files)
    baseline = (
        BundleSnapshot(manifest=base.manifest, files=base.files) if base is not None else None
    )
    result = diff_bundles(current, baseline, base.version if base is not None else None)
    return BundleDiff(
        bundle_id=bundle.id,
        against_bundle_id=base.id if base is not None else None,
        features=result.features,
        sections=result.sections,
        summary=result.summary,
    )


async def load_file_content(store: BundleStore, bundle: BundleRow, path: str) -> BundleFileContent:
    known = any(entry.get("path") == path for entry in bundle.files)
    if not known or bundle.storage_path is None:
        raise not_found("The bundle has no such file")
    raw = await store.read(bundle.storage_path, path, MAX_PREVIEW_BYTES + 1)
    if raw is None:
        raise not_found("The stored file is no longer available")
    truncated = len(raw) > MAX_PREVIEW_BYTES
    content = raw[:MAX_PREVIEW_BYTES].decode("utf-8", errors="replace")
    return BundleFileContent(path=path, content=content, truncated=truncated)
