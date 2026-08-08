from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from tessa_api.deps import (
    SessionDep,
    SettingsDep,
    ViewerUser,
)
from tessa_api.errors import error_responses
from tessa_api.schemas.coverage import CoverageMap
from tessa_api.schemas.enums import CellStatus
from tessa_api.services import coverage as coverage_service
from tessa_api.services import proposals as proposal_service
from tessa_api.services.coverage import CoverageQuery
from tessa_api.services.pagination import UnknownQueryRejected
from tessa_api.services.storage import bundle_store_from_settings
from tessa_api.services.vault import VaultDep

router = APIRouter(tags=["coverage"])


@router.get(
    "/coverage",
    response_model=CoverageMap,
    summary="Coverage heatmap; without plan_id it reads the hidden baseline plan of the bundle",
    responses=error_responses(401, 403, 404, 409, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_coverage(
    user: ViewerUser,
    session: SessionDep,
    settings: SettingsDep,
    vault: VaultDep,
    target_id: Annotated[UUID, Query(description="target whose coverage is read")],
    plan_id: Annotated[
        UUID | None, Query(description="plan to read instead of the baseline")
    ] = None,
    bundle_id: Annotated[
        UUID | None, Query(description="bundle of the baseline plan; default is the latest valid")
    ] = None,
    area: Annotated[list[str] | None, Query(description="only features of these areas")] = None,
    status: Annotated[
        list[CellStatus] | None, Query(description="only cells in these states")
    ] = None,
) -> CoverageMap:
    query = CoverageQuery(
        target_id=target_id,
        plan_id=plan_id,
        bundle_id=bundle_id,
        areas=area or (),
        statuses=status or (),
    )
    result = await coverage_service.read_coverage(
        session, settings, vault, bundle_store_from_settings(settings), user.id, query
    )
    result.cells = await proposal_service.annotate_coverage(session, result.target_id, result.cells)
    await session.commit()
    return result
