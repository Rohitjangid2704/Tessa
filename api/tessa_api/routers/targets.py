from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from tessa_api.deps import AdminUser, MemberUser, SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import AppKind, TargetTier
from tessa_api.schemas.targets import Target, TargetCreate, TargetPage, TargetUpdate
from tessa_api.services import targets as target_service
from tessa_api.services.pagination import PageQuery, page_query
from tessa_api.services.target_token import rotate_token

router = APIRouter(tags=["targets"])

TARGET_SORT_KEYS = ("name", "created_at")
TargetPageQuery = Annotated[PageQuery, Depends(page_query(TARGET_SORT_KEYS, "-created_at"))]


@router.get(
    "/targets",
    response_model=TargetPage,
    summary="List targets",
    responses=error_responses(401, 403, 422),
)
async def list_targets(
    user: ViewerUser,
    session: SessionDep,
    page: TargetPageQuery,
    q: Annotated[str | None, Query(max_length=200, description="Name or slug contains")] = None,
    app_kind: Annotated[list[AppKind] | None, Query()] = None,
    tier: Annotated[list[TargetTier] | None, Query()] = None,
    include_archived: Annotated[bool, Query()] = False,
) -> TargetPage:
    return await target_service.list_targets(session, page, q, app_kind, tier, include_archived)


@router.post(
    "/targets",
    status_code=201,
    response_model=Target,
    summary="Create a target",
    responses=error_responses(401, 403, 422),
)
async def create_target(body: TargetCreate, user: MemberUser, session: SessionDep) -> Target:
    return await target_service.create_target(session, user, body)


@router.get(
    "/targets/{target_id}",
    response_model=Target,
    summary="Read one target",
    responses=error_responses(401, 403, 404),
)
async def read_target(target_id: UUID, user: ViewerUser, session: SessionDep) -> Target:
    return await target_service.read_target(session, target_id)


@router.patch(
    "/targets/{target_id}",
    response_model=Target,
    summary="Edit a target; allow_production and a production tier are admin only",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def update_target(
    target_id: UUID, body: TargetUpdate, user: MemberUser, session: SessionDep
) -> Target:
    return await target_service.update_target(session, user, target_id, body)


@router.delete(
    "/targets/{target_id}",
    status_code=204,
    summary="Archive a target",
    responses=error_responses(401, 403, 404),
)
async def archive_target(target_id: UUID, user: AdminUser, session: SessionDep) -> Response:
    await target_service.archive_target(session, target_id)
    return Response(status_code=204)


@router.post(
    "/targets/{target_id}/token/rotate",
    response_model=Target,
    summary="Issue a new target token; the previous one keeps matching uploads",
    responses=error_responses(401, 403, 404, 409),
)
async def rotate_target_token(target_id: UUID, user: MemberUser, session: SessionDep) -> Target:
    target = await target_service.get_active_target(session, target_id)
    await rotate_token(session, target)
    await session.commit()
    return await target_service.read_target(session, target_id)
