import uuid
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Form, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select

from tessa_api.db.models import BundleRow
from tessa_api.deps import (
    IdempotencyDep,
    MemberUser,
    SessionDep,
    SessionFactoryDep,
    SettingsDep,
    ViewerOrServiceUser,
    ViewerUser,
)
from tessa_api.errors import ApiError, error_responses, not_found
from tessa_api.schemas.bundles import (
    Bundle,
    BundleDiff,
    BundleFileContent,
    BundleFileEntry,
    BundleFileList,
    BundlePasteCreate,
    BundleSummaryPage,
    BundleUploadForm,
    BundleUploadResult,
    BundleValidationReport,
)
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import BundleSourceKind
from tessa_api.services.authored_dry_runs import start_authored_dry_runs
from tessa_api.services.bundle_archive import ZIP_CONTENT_TYPES
from tessa_api.services.bundle_intake import IntakeResult, intake_bundle
from tessa_api.services.bundle_validate import validate_bundle_archive
from tessa_api.services.bundle_views import (
    build_bundle_diff,
    load_file_content,
    to_bundle,
    to_bundle_summary,
)
from tessa_api.services.pagination import PageQuery, page_query, paginate, sortable
from tessa_api.services.storage import bundle_store_from_settings
from tessa_api.services.targets import get_target
from tessa_api.services.vault import VaultDep
from tessa_api.streams.dependencies import HubDep
from tessa_api.temporal_client import TemporalDep

router = APIRouter(tags=["bundles"])

BUNDLE_SORT_KEYS = ("version",)
BundlePageQuery = Annotated[PageQuery, Depends(page_query(BUNDLE_SORT_KEYS, "-version"))]
UploadFormBody = Annotated[BundleUploadForm, Form(media_type="multipart/form-data")]
BUNDLE_SORT_COLUMNS = {"version": sortable(BundleRow.version, int)}
BUNDLE_ID_COLUMN = sortable(BundleRow.id, uuid.UUID)

UPLOAD_RESPONSES = {
    200: {"model": BundleUploadResult, "description": "Identical content already stored"},
    **error_responses(400, 401, 403, 409, 413, 415, 422),
}


def unsupported_media_type(content_type: str | None) -> ApiError:
    shown = content_type or "none"
    message = f"The file must be a zip (application/zip), not {shown}"
    detail = ErrorDetail(loc=["form", "file"], code="unsupported_media_type", message=message)
    return ApiError(415, "unsupported_media_type", message, [detail])


def media_type_of(content_type: str | None) -> str:
    return (content_type or "").split(";", 1)[0].strip().lower()


async def respond_with_result(
    idempotency: IdempotencyDep, result: IntakeResult, dry_run_run_id: UUID | None = None
) -> JSONResponse:
    body = BundleUploadResult(
        bundle=to_bundle(result.row), created=result.created, dry_run_run_id=dry_run_run_id
    )
    return await idempotency.respond(body, 201 if result.created else 200)


async def load_bundle(session: SessionDep, bundle_id: UUID) -> BundleRow:
    row = await session.get(BundleRow, bundle_id)
    if row is None:
        raise not_found("Bundle not found")
    return row


@router.post(
    "/bundles",
    status_code=201,
    response_model=BundleUploadResult,
    summary="Upload a bundle zip",
    responses=UPLOAD_RESPONSES,
)
async def upload_bundle(
    form: UploadFormBody,
    user: MemberUser,
    idempotency: IdempotencyDep,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
    vault: VaultDep,
    hub: HubDep,
    temporal: TemporalDep,
) -> JSONResponse:
    upload = form.file
    if media_type_of(upload.content_type) not in ZIP_CONTENT_TYPES:
        raise unsupported_media_type(upload.content_type)
    result = await intake_bundle(
        session,
        settings,
        bundle_store_from_settings(settings),
        user,
        BundleSourceKind.zip,
        form.target_id,
        form.note,
        archive=upload.file,
    )
    dry_run_run_id = await start_authored_dry_runs(
        session,
        session_factory,
        hub,
        temporal,
        settings,
        vault,
        user.id,
        result.row,
        result.imported,
    )
    return await respond_with_result(idempotency, result, dry_run_run_id)


@router.post(
    "/bundles/validate",
    response_model=BundleValidationReport,
    summary="Validate, score and diff a bundle zip and list everything that is open, storing "
    "nothing",
    responses=error_responses(400, 401, 403, 409, 413, 415, 422),
)
async def validate_bundle_upload(
    form: UploadFormBody, user: MemberUser, session: SessionDep, settings: SettingsDep
) -> BundleValidationReport:
    upload = form.file
    if media_type_of(upload.content_type) not in ZIP_CONTENT_TYPES:
        raise unsupported_media_type(upload.content_type)
    return await validate_bundle_archive(session, settings, upload.file, form.target_id)


@router.post(
    "/bundles/paste",
    status_code=201,
    response_model=BundleUploadResult,
    summary="Paste a manifest.yaml",
    responses=UPLOAD_RESPONSES,
)
async def paste_bundle(
    body: BundlePasteCreate,
    user: MemberUser,
    idempotency: IdempotencyDep,
    session: SessionDep,
    settings: SettingsDep,
) -> JSONResponse:
    result = await intake_bundle(
        session,
        settings,
        bundle_store_from_settings(settings),
        user,
        BundleSourceKind.manifest_paste,
        body.target_id,
        body.note,
        manifest_yaml=body.manifest_yaml,
    )
    return await respond_with_result(idempotency, result)


@router.get(
    "/targets/{target_id}/bundles",
    response_model=BundleSummaryPage,
    summary="Bundle versions of a target; the service key may read them (the contract gate "
    "resolves the latest valid bundle of a target)",
    responses=error_responses(401, 403, 404, 422),
)
async def list_bundles(
    target_id: UUID, caller: ViewerOrServiceUser, page: BundlePageQuery, session: SessionDep
) -> BundleSummaryPage:
    await get_target(session, target_id)
    result = await paginate(
        session,
        select(BundleRow).where(BundleRow.target_id == target_id),
        BUNDLE_SORT_COLUMNS,
        BUNDLE_ID_COLUMN,
        page,
    )
    return BundleSummaryPage(
        items=[to_bundle_summary(row[0]) for row in result.rows],
        next_cursor=result.next_cursor,
        total=result.total,
    )


@router.get(
    "/bundles/{bundle_id}",
    response_model=Bundle,
    summary="Validation errors, completeness and diff summary of a bundle",
    responses=error_responses(401, 403, 404),
)
async def read_bundle(bundle_id: UUID, user: ViewerUser, session: SessionDep) -> Bundle:
    return to_bundle(await load_bundle(session, bundle_id))


@router.get(
    "/bundles/{bundle_id}/diff",
    response_model=BundleDiff,
    summary="Full diff against the previous valid version or against another bundle",
    responses=error_responses(401, 403, 404, 422),
)
async def read_bundle_diff(
    bundle_id: UUID,
    user: ViewerUser,
    session: SessionDep,
    against: Annotated[UUID | None, Query(description="bundle id to compare with")] = None,
) -> BundleDiff:
    return await build_bundle_diff(session, await load_bundle(session, bundle_id), against)


@router.get(
    "/bundles/{bundle_id}/files",
    response_model=BundleFileList,
    summary="Stored files of a bundle",
    responses=error_responses(401, 403, 404),
)
async def list_bundle_files(
    bundle_id: UUID, user: ViewerUser, session: SessionDep
) -> BundleFileList:
    row = await load_bundle(session, bundle_id)
    return BundleFileList(items=[BundleFileEntry.model_validate(entry) for entry in row.files])


@router.get(
    "/bundles/{bundle_id}/files/{path:path}",
    response_model=BundleFileContent,
    summary="Text preview of a stored file, at most 1 MiB",
    responses=error_responses(401, 403, 404),
)
async def read_bundle_file(
    bundle_id: UUID, path: str, user: ViewerUser, session: SessionDep, settings: SettingsDep
) -> BundleFileContent:
    row = await load_bundle(session, bundle_id)
    return await load_file_content(bundle_store_from_settings(settings), row, path)
