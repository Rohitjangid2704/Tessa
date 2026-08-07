import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.errors import ApiError, not_found
from tessa_api.schemas.common import ErrorDetail
from tessa_api.services.bundle_views import hooks_missing
from tessa_api.services.prompts.hooks import HookRequest, HooksInputs


def no_missing_hooks_error(version: int) -> ApiError:
    return ApiError(
        422,
        "validation_failed",
        "Request validation failed",
        [
            ErrorDetail(
                loc=["body", "bundle_id"],
                code="no_missing_hooks",
                message=f"Version {version} of the bundle lists no test hook as missing, so "
                "there is nothing to ask for",
            )
        ],
    )


async def load_hooks_inputs(
    session: AsyncSession, target: TargetRow, bundle_id: uuid.UUID
) -> tuple[HooksInputs, BundleRow]:
    bundle = await session.get(BundleRow, bundle_id)
    if bundle is None or bundle.target_id != target.id:
        raise not_found("Bundle not found for this target")
    missing = hooks_missing(bundle.manifest)
    if not missing:
        raise no_missing_hooks_error(bundle.version)
    return (
        HooksInputs(
            target_token=target.target_token,
            bundle_version=bundle.version,
            hooks=tuple(HookRequest(hook.id, hook.description) for hook in missing),
        ),
        bundle,
    )
