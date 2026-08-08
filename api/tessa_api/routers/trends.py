from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from tessa_api.deps import SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import TrendMetric
from tessa_api.schemas.trends import TrendSeries
from tessa_api.services import trends
from tessa_api.services.pagination import UnknownQueryRejected

router = APIRouter(tags=["trends"])


@router.get(
    "/trends",
    response_model=TrendSeries,
    summary="One metric over the finished full-suite runs of a target; subset runs are left out",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_trend(
    user: ViewerUser,
    session: SessionDep,
    target_id: Annotated[UUID, Query(description="target whose runs are charted")],
    metric: Annotated[TrendMetric, Query(description="metric read from runs.stats")],
    from_: Annotated[
        datetime | None, Query(alias="from", description="ISO 8601 lower bound of the run finish")
    ] = None,
    to: Annotated[
        datetime | None, Query(description="ISO 8601 upper bound of the run finish")
    ] = None,
    plan_id: Annotated[UUID | None, Query(description="only runs of this plan")] = None,
) -> TrendSeries:
    return await trends.read_trend(session, target_id, metric, from_, to, plan_id)
