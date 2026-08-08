from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from tessa_api.deps import SessionDep, SettingsDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.dashboard import DashboardSummary
from tessa_api.services.dashboard import build_dashboard
from tessa_api.services.pagination import UnknownQueryRejected
from tessa_api.services.targets import get_target

router = APIRouter(tags=["dashboard"])


@router.get(
    "/dashboard",
    response_model=DashboardSummary,
    summary="Home dashboard: last nightly pass^k, open findings, weekly cost, suite power, kappa",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_dashboard(
    user: ViewerUser,
    session: SessionDep,
    settings: SettingsDep,
    target_id: Annotated[
        UUID | None, Query(description="only this target; absent means every target")
    ] = None,
) -> DashboardSummary:
    if target_id is not None:
        await get_target(session, target_id)
    return await build_dashboard(session, settings, target_id)
