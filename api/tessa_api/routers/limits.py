from fastapi import APIRouter

from tessa_api.deps import SettingsDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.limits import LimitsRead

router = APIRouter(tags=["limits"])


@router.get(
    "/limits",
    response_model=LimitsRead,
    summary="Upload and text limits for client side pre-checks",
    responses=error_responses(401, 403),
)
async def read_limits(user: ViewerUser, settings: SettingsDep) -> LimitsRead:
    return LimitsRead(
        bundle_max_zip_bytes=settings.bundle_max_zip_bytes,
        bundle_max_manifest_bytes=settings.bundle_max_manifest_bytes,
        explanation_max_chars=settings.explanation_max_chars,
    )
