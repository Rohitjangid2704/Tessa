from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import JSONResponse

from tessa_api.deps import (
    MemberUser,
    OptionalIdempotencyDep,
    SessionDep,
    SettingsDep,
    ViewerUser,
)
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import CellStatus
from tessa_api.schemas.plans import (
    CoverageCellPage,
    Plan,
    PlanCreate,
    PlanPage,
    PlanPreview,
    PlanUpdate,
)
from tessa_api.services import plans as plan_service
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query
from tessa_api.services.storage import bundle_store_from_settings
from tessa_api.services.vault import VaultDep

router = APIRouter(tags=["plans"])

PLAN_SORT_KEYS = ("created_at",)
CELL_SORT_KEYS = ("feature_id", "role", "interface_id", "status")
CELL_DEFAULT_SORT = "feature_id,role,interface_id"
PlanPageQuery = Annotated[PageQuery, Depends(page_query(PLAN_SORT_KEYS, "-created_at"))]
CellPageQuery = Annotated[PageQuery, Depends(page_query(CELL_SORT_KEYS, CELL_DEFAULT_SORT))]


@router.post(
    "/plans/preview",
    response_model=PlanPreview,
    summary="Preview the cells and scenarios a selection expands to, saving nothing",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def preview_plan(
    body: PlanCreate,
    user: ViewerUser,
    session: SessionDep,
    settings: SettingsDep,
    vault: VaultDep,
) -> PlanPreview:
    return await plan_service.preview_plan(
        session, settings, vault, bundle_store_from_settings(settings), body
    )


@router.post(
    "/plans",
    status_code=201,
    response_model=Plan,
    summary="Save a plan and materialise its coverage cells",
    responses=error_responses(400, 401, 403, 404, 409, 422),
)
async def create_plan(
    body: PlanCreate,
    user: MemberUser,
    session: SessionDep,
    settings: SettingsDep,
    vault: VaultDep,
    idempotency: OptionalIdempotencyDep,
) -> Plan | JSONResponse:
    plan = await plan_service.create_plan(session, settings, vault, user.id, body)
    await session.commit()
    if idempotency is None:
        return plan
    return await idempotency.respond(plan, 201)


@router.get(
    "/plans",
    response_model=PlanPage,
    summary="Saved plans, never the hidden coverage baseline plans",
    responses=error_responses(401, 403, 422),
)
async def list_plans(
    user: ViewerUser,
    session: SessionDep,
    page: PlanPageQuery,
    target_id: Annotated[UUID | None, Query(description="only plans of this target")] = None,
    saved: Annotated[bool | None, Query(description="filter on the saved flag")] = None,
) -> PlanPage:
    return await plan_service.list_plans(session, page, target_id, saved)


@router.get(
    "/plans/{plan_id}",
    response_model=Plan,
    summary="One plan",
    responses=error_responses(401, 403, 404),
    dependencies=[UnknownQueryRejected],
)
async def read_plan(plan_id: UUID, user: ViewerUser, session: SessionDep) -> Plan:
    return await plan_service.read_plan(session, plan_id)


@router.patch(
    "/plans/{plan_id}",
    response_model=Plan,
    summary="Rename a plan or change its selection",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def update_plan(
    plan_id: UUID,
    body: PlanUpdate,
    user: MemberUser,
    session: SessionDep,
    settings: SettingsDep,
    vault: VaultDep,
) -> Plan:
    plan = await plan_service.update_plan(session, settings, vault, plan_id, body)
    await session.commit()
    return plan


@router.delete(
    "/plans/{plan_id}",
    status_code=204,
    response_class=Response,
    summary="Delete a plan",
    responses=error_responses(401, 403, 404, 409),
)
async def delete_plan(plan_id: UUID, user: MemberUser, session: SessionDep) -> Response:
    await plan_service.delete_plan(session, plan_id)
    await session.commit()
    return Response(status_code=204)


@router.get(
    "/plans/{plan_id}/cells",
    response_model=CoverageCellPage,
    summary="Coverage cells of a plan",
    responses=error_responses(401, 403, 404, 422),
)
async def list_plan_cells(
    plan_id: UUID,
    user: ViewerUser,
    session: SessionDep,
    page: CellPageQuery,
    status: Annotated[list[CellStatus] | None, Query(description="cell status")] = None,
    feature_id: Annotated[list[str] | None, Query(description="manifest feature id")] = None,
) -> CoverageCellPage:
    return await plan_service.list_plan_cells(
        session, plan_id, page, status or (), feature_id or ()
    )
