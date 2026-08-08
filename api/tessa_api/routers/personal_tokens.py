from uuid import UUID

from fastapi import APIRouter, Response

from tessa_api.deps import AdminUser, SessionDep, SettingsDep, ViewerUser
from tessa_api.errors import error_responses, forbidden
from tessa_api.schemas.personal_tokens import (
    PersonalTokenCreate,
    PersonalTokenCreated,
    PersonalTokenList,
)
from tessa_api.services import personal_tokens as token_service
from tessa_api.services.audit_context import AuthKind, current_audit_context

router = APIRouter(tags=["personal-tokens"])


@router.get(
    "/users/me/tokens",
    response_model=PersonalTokenList,
    summary="Personal tokens of the caller, newest first, with their state",
    responses=error_responses(401, 403),
)
async def list_my_tokens(user: ViewerUser, session: SessionDep) -> PersonalTokenList:
    return await token_service.list_tokens(session, user.id)


@router.post(
    "/users/me/tokens",
    status_code=201,
    response_model=PersonalTokenCreated,
    summary="Create a personal token for Claude Code; the token is shown once and sends no "
    "Idempotency-Key because the response holds a secret",
    responses=error_responses(401, 403, 409, 422),
)
async def create_my_token(
    body: PersonalTokenCreate, user: ViewerUser, session: SessionDep, settings: SettingsDep
) -> PersonalTokenCreated:
    if current_audit_context().auth_kind is AuthKind.personal:
        raise forbidden("A personal token cannot create another personal token; sign in first")
    return await token_service.create_token(session, settings, user, body)


@router.delete(
    "/users/me/tokens/{token_id}",
    status_code=204,
    summary="Revoke one of the caller's personal tokens; revoking twice is not an error",
    responses=error_responses(401, 403, 404),
)
async def revoke_my_token(token_id: UUID, user: ViewerUser, session: SessionDep) -> Response:
    await token_service.revoke_token(session, user.id, user.id, token_id)
    return Response(status_code=204)


@router.get(
    "/users/{user_id}/tokens",
    response_model=PersonalTokenList,
    summary="Personal tokens of a user, for administrators",
    responses=error_responses(401, 403, 404),
)
async def list_user_tokens(
    user_id: UUID, user: AdminUser, session: SessionDep
) -> PersonalTokenList:
    await token_service.ensure_user_exists(session, user_id)
    return await token_service.list_tokens(session, user_id)


@router.delete(
    "/users/{user_id}/tokens/{token_id}",
    status_code=204,
    summary="Revoke a personal token of any user, for administrators",
    responses=error_responses(401, 403, 404),
)
async def revoke_user_token(
    user_id: UUID, token_id: UUID, user: AdminUser, session: SessionDep
) -> Response:
    await token_service.ensure_user_exists(session, user_id)
    await token_service.revoke_token(session, user.id, user_id, token_id)
    return Response(status_code=204)
