from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse

from tessa_api.deps import (
    MemberOrServiceUser,
    MemberUser,
    SessionDep,
    SessionFactoryDep,
    SettingsDep,
    ViewerUser,
    begin_owned_idempotency,
)
from tessa_api.errors import error_responses
from tessa_api.schemas.common import RunHandle
from tessa_api.schemas.enums import ScheduleTier
from tessa_api.schemas.schedules import (
    Schedule,
    ScheduleCreate,
    SchedulePage,
    ScheduleUpdate,
)
from tessa_api.services import schedule_views, scheduled_runs, schedules
from tessa_api.services.idempotency import IdempotencyContext, IdempotencyKeyHeader
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query
from tessa_api.services.vault import VaultDep
from tessa_api.streams.dependencies import HubDep
from tessa_api.temporal_client import TemporalDep

router = APIRouter(tags=["schedules"])

SCHEDULE_SORT_KEYS = ("created_at",)
SchedulePageQuery = Annotated[PageQuery, Depends(page_query(SCHEDULE_SORT_KEYS, "-created_at"))]


async def get_run_now_idempotency(
    request: Request,
    schedule_id: UUID,
    key: IdempotencyKeyHeader,
    caller: MemberOrServiceUser,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
) -> AsyncIterator[IdempotencyContext]:
    user_id = None if caller.user is None else caller.user.id
    scope = await scheduled_runs.run_now_scope(session, user_id, schedule_id, key)
    context = await begin_owned_idempotency(
        request, scope.key, scope.owner_id, session_factory, settings
    )
    try:
        yield context
    finally:
        await context.release()


RunNowIdempotencyDep = Annotated[IdempotencyContext, Depends(get_run_now_idempotency)]


@router.get(
    "/schedules",
    response_model=SchedulePage,
    summary="Schedules of saved plans",
    responses=error_responses(401, 403, 422),
)
async def list_schedules(
    user: ViewerUser,
    session: SessionDep,
    page: SchedulePageQuery,
    plan_id: Annotated[UUID | None, Query(description="only schedules of this plan")] = None,
    tier: Annotated[list[ScheduleTier] | None, Query()] = None,
    enabled: Annotated[bool | None, Query()] = None,
) -> SchedulePage:
    filters = schedule_views.ScheduleFilters(plan_id=plan_id, tiers=tier or (), enabled=enabled)
    return await schedule_views.list_schedules(session, page, filters)


@router.post(
    "/schedules",
    status_code=201,
    response_model=Schedule,
    summary="Create a schedule; a Temporal Schedule is created with it",
    responses=error_responses(401, 403, 404, 409, 422, 503),
)
async def create_schedule(
    body: ScheduleCreate, user: MemberUser, session: SessionDep, temporal: TemporalDep
) -> Schedule:
    return await schedules.create_schedule(session, temporal, user.id, body)


@router.get(
    "/schedules/{schedule_id}",
    response_model=Schedule,
    summary="One schedule with its next firing",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_schedule(
    schedule_id: UUID, user: ViewerUser, session: SessionDep, temporal: TemporalDep
) -> Schedule:
    return await schedule_views.read_schedule(session, temporal, schedule_id)


@router.patch(
    "/schedules/{schedule_id}",
    response_model=Schedule,
    summary="Edit, enable or disable a schedule",
    responses=error_responses(401, 403, 404, 409, 422, 503),
)
async def update_schedule(
    schedule_id: UUID,
    body: ScheduleUpdate,
    user: MemberUser,
    session: SessionDep,
    temporal: TemporalDep,
) -> Schedule:
    return await schedules.update_schedule(session, temporal, schedule_id, body)


@router.delete(
    "/schedules/{schedule_id}",
    status_code=204,
    response_class=Response,
    summary="Delete a schedule and its Temporal Schedule",
    responses=error_responses(401, 403, 404, 503),
)
async def delete_schedule(
    schedule_id: UUID, user: MemberUser, session: SessionDep, temporal: TemporalDep
) -> Response:
    await schedules.delete_schedule(session, temporal, schedule_id)
    return Response(status_code=204)


@router.post(
    "/schedules/{schedule_id}/run-now",
    status_code=202,
    response_model=RunHandle,
    summary="Run a schedule's plan now; also the CI hook of the commit tier through the service "
    "key",
    responses=error_responses(400, 401, 403, 404, 409, 422, 503),
)
async def run_now(
    schedule_id: UUID,
    caller: MemberOrServiceUser,
    idempotency: RunNowIdempotencyDep,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
    vault: VaultDep,
    hub: HubDep,
    temporal: TemporalDep,
) -> JSONResponse:
    handle = await scheduled_runs.start_run_now(
        session,
        session_factory,
        hub,
        temporal,
        settings,
        vault,
        schedule_id,
        None if caller.user is None else caller.user.id,
    )
    return await idempotency.respond(handle, 202)
