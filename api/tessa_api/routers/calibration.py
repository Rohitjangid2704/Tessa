from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from tessa_api.deps import SessionDep, SettingsDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.calibration import CalibrationReport
from tessa_api.services.calibration import build_calibration_report
from tessa_api.services.pagination import UnknownQueryRejected
from tessa_api.services.targets import get_target

router = APIRouter(tags=["calibration"])


@router.get(
    "/calibration",
    response_model=CalibrationReport,
    summary="Agreement of probes and judges with human labels as Cohen's kappa",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_report(
    user: ViewerUser,
    session: SessionDep,
    settings: SettingsDep,
    target_id: Annotated[
        UUID | None, Query(description="only labels of this target; absent means every target")
    ] = None,
) -> CalibrationReport:
    if target_id is not None:
        await get_target(session, target_id)
    return await build_calibration_report(session, settings, target_id)
