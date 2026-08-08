from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from tessa_api.deps import AdminUser, OptionalIdempotencyDep, SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.auth import AuthUser
from tessa_api.schemas.enums import UserRole
from tessa_api.schemas.users import User, UserCreate, UserPage, UserUpdate
from tessa_api.services import users as user_service
from tessa_api.services.pagination import PageQuery, page_query

router = APIRouter(tags=["users"])

USER_SORT_KEYS = ("created_at", "email", "name")
UserPageQuery = Annotated[PageQuery, Depends(page_query(USER_SORT_KEYS, "email"))]


@router.get(
    "/me",
    response_model=AuthUser,
    summary="The authenticated user",
    responses=error_responses(401, 403),
)
async def read_me(user: ViewerUser) -> AuthUser:
    return AuthUser(id=user.id, email=user.email, name=user.name, role=user.role)


@router.get(
    "",
    response_model=UserPage,
    summary="User administration: list users with their teams",
    responses=error_responses(401, 403, 422),
)
async def list_users(
    user: AdminUser,
    session: SessionDep,
    page: UserPageQuery,
    q: Annotated[str | None, Query(max_length=200, description="Email or name contains")] = None,
    role: Annotated[list[UserRole] | None, Query(description="only users with these roles")] = None,
    is_active: Annotated[bool | None, Query(description="only active or inactive users")] = None,
) -> UserPage:
    return await user_service.list_users(session, page, q, role, is_active)


@router.post(
    "",
    status_code=201,
    response_model=User,
    summary="Create a user; without a password the user cannot sign in",
    responses=error_responses(400, 401, 403, 409, 422),
)
async def create_user(
    body: UserCreate,
    user: AdminUser,
    idempotency: OptionalIdempotencyDep,
    session: SessionDep,
) -> JSONResponse:
    created = await user_service.create_user_account(session, user, body)
    if idempotency is None:
        return JSONResponse(status_code=201, content=created.model_dump(mode="json"))
    return await idempotency.respond(created, 201)


@router.patch(
    "/{user_id}",
    response_model=User,
    summary="Change the name, role or active flag of a user; an admin cannot demote or "
    "deactivate themselves and the last active admin cannot be removed",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def update_user(
    user_id: UUID, body: UserUpdate, user: AdminUser, session: SessionDep
) -> User:
    return await user_service.update_user_account(session, user, user_id, body)
