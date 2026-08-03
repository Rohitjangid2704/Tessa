import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.auth.jwt import decode_api_token
from tessa_api.auth.personal_tokens import is_personal_token
from tessa_api.auth.service_key import service_key_matches
from tessa_api.db.models import User
from tessa_api.db.session import SessionFactory, get_session
from tessa_api.errors import IdempotentReplay, forbidden, unauthenticated
from tessa_api.schemas.enums import UserRole
from tessa_api.services.agent_sessions import agent_session_of
from tessa_api.services.audit_context import current_audit_context
from tessa_api.services.idempotency import (
    IdempotencyContext,
    IdempotencyKeyHeader,
    OptionalIdempotencyKeyHeader,
    begin,
    compute_request_hash,
)
from tessa_api.services.personal_tokens import authenticate_personal_token
from tessa_api.services.rate_limit import LoginRateLimiter
from tessa_api.services.request_fingerprint import idempotency_body
from tessa_api.settings import Settings
from tessa_api.streams.guard import PersonalTokenGuard, StreamGuard

AGENT_SESSION_HEADER = "X-Agent-Session"
BEARER_DESCRIPTION = (
    "Either an HS256 session token minted by the web app (JWT, five minutes) or a personal "
    "token that starts with ipt_ (created on POST /users/me/tokens). A request made with a "
    "personal token may carry the header X-Agent-Session with the id of an agent session of the "
    "same user; its writes are then listed in the audit log under that session."
)
bearer_scheme = HTTPBearer(
    scheme_name="bearerAuth",
    bearerFormat="JWT or ipt_ personal token",
    description=BEARER_DESCRIPTION,
    auto_error=False,
)
service_key_scheme = APIKeyHeader(name="X-Service-Key", scheme_name="serviceKey", auto_error=False)

ROLE_RANK = {UserRole.viewer: 0, UserRole.member: 1, UserRole.admin: 2}


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_session_factory(request: Request) -> SessionFactory:
    session_factory: SessionFactory = request.app.state.session_factory
    return session_factory


def get_login_rate_limiter(request: Request) -> LoginRateLimiter:
    limiter: LoginRateLimiter = request.app.state.login_rate_limiter
    return limiter


SettingsDep = Annotated[Settings, Depends(get_settings)]
SessionDep = Annotated[AsyncSession, Depends(get_session)]
SessionFactoryDep = Annotated[SessionFactory, Depends(get_session_factory)]
LoginRateLimiterDep = Annotated[LoginRateLimiter, Depends(get_login_rate_limiter)]


async def resolve_bearer_user(
    request: Request, token: str, settings: Settings, session: AsyncSession
) -> User:
    context = current_audit_context()
    if is_personal_token(token):
        authenticated = await authenticate_personal_token(session, token)
        agent_session_id = await agent_session_of(
            session, authenticated.user.id, request.headers.get(AGENT_SESSION_HEADER)
        )
        context.mark_personal(authenticated.user.id, authenticated.token.id, agent_session_id)
        return authenticated.user
    claims = decode_api_token(token, settings)
    user = await session.get(User, claims.user_id)
    if user is None or not user.is_active:
        raise unauthenticated("Unknown or inactive user")
    context.mark_session(user.id)
    return user


async def get_current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    settings: SettingsDep,
    session: SessionDep,
) -> User:
    if credentials is None:
        raise unauthenticated()
    return await resolve_bearer_user(request, credentials.credentials, settings, session)


async def get_stream_viewer(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    settings: SettingsDep,
    session_factory: SessionFactoryDep,
) -> User:
    if credentials is None:
        raise unauthenticated()
    async with session_factory() as session:
        return await resolve_bearer_user(request, credentials.credentials, settings, session)


async def get_stream_guard(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    viewer: Annotated[User, Depends(get_stream_viewer)],
    session_factory: SessionFactoryDep,
) -> StreamGuard | None:
    if credentials is None or not is_personal_token(credentials.credentials):
        return None
    return PersonalTokenGuard(session_factory, credentials.credentials)


def require_role(minimum: UserRole) -> Callable[[User], Awaitable[User]]:
    async def dependency(user: Annotated[User, Depends(get_current_user)]) -> User:
        if ROLE_RANK[user.role] < ROLE_RANK[minimum]:
            raise forbidden(f"Requires role {minimum.value} or higher", code="role_required")
        return user

    return dependency


async def require_service_key(
    provided: Annotated[str | None, Depends(service_key_scheme)],
    settings: SettingsDep,
) -> None:
    if not service_key_matches(provided, settings):
        raise unauthenticated("Invalid service key")
    current_audit_context().mark_service()


async def begin_owned_idempotency(
    request: Request,
    key: str,
    owner_id: uuid.UUID,
    session_factory: SessionFactory,
    settings: Settings,
) -> IdempotencyContext:
    body = await idempotency_body(request)
    request_hash = compute_request_hash(request.method, request.url.path, body)
    stored = await begin(
        session_factory,
        owner_id,
        key,
        request.method,
        request.url.path,
        request_hash,
        settings.idempotency_ttl_hours,
    )
    if stored is not None:
        raise IdempotentReplay(stored.status_code, stored.body)
    return IdempotencyContext(session_factory, owner_id, key)


async def begin_idempotency(
    request: Request,
    key: str,
    user: User,
    session_factory: SessionFactory,
    settings: Settings,
) -> IdempotencyContext:
    return await begin_owned_idempotency(request, key, user.id, session_factory, settings)


async def get_idempotency(
    request: Request,
    key: IdempotencyKeyHeader,
    user: Annotated[User, Depends(get_current_user)],
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
) -> AsyncIterator[IdempotencyContext]:
    context = await begin_idempotency(request, key, user, session_factory, settings)
    try:
        yield context
    finally:
        await context.release()


async def get_optional_idempotency(
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
    key: OptionalIdempotencyKeyHeader = None,
) -> AsyncIterator[IdempotencyContext | None]:
    if key is None:
        yield None
        return
    context = await begin_idempotency(request, key, user, session_factory, settings)
    try:
        yield context
    finally:
        await context.release()


@dataclass(frozen=True, slots=True)
class MemberOrServiceCaller:
    user: User | None

    @property
    def is_service(self) -> bool:
        return self.user is None


async def get_member_or_service_caller(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    provided_key: Annotated[str | None, Depends(service_key_scheme)],
    settings: SettingsDep,
    session: SessionDep,
) -> MemberOrServiceCaller:
    if credentials is None:
        if not service_key_matches(provided_key, settings):
            raise unauthenticated("A bearer token or a service key is required")
        current_audit_context().mark_service()
        return MemberOrServiceCaller(user=None)
    user = await get_current_user(request, credentials, settings, session)
    if ROLE_RANK[user.role] < ROLE_RANK[UserRole.member]:
        raise forbidden(f"Requires role {UserRole.member.value} or higher", code="role_required")
    return MemberOrServiceCaller(user=user)


async def get_viewer_or_service_caller(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    provided_key: Annotated[str | None, Depends(service_key_scheme)],
    settings: SettingsDep,
    session: SessionDep,
) -> MemberOrServiceCaller:
    if credentials is None:
        if not service_key_matches(provided_key, settings):
            raise unauthenticated("A bearer token or a service key is required")
        current_audit_context().mark_service()
        return MemberOrServiceCaller(user=None)
    return MemberOrServiceCaller(
        user=await get_current_user(request, credentials, settings, session)
    )


CurrentUser = Annotated[User, Depends(get_current_user)]
MemberOrServiceUser = Annotated[MemberOrServiceCaller, Depends(get_member_or_service_caller)]
ViewerOrServiceUser = Annotated[MemberOrServiceCaller, Depends(get_viewer_or_service_caller)]
IdempotencyDep = Annotated[IdempotencyContext, Depends(get_idempotency)]
OptionalIdempotencyDep = Annotated[IdempotencyContext | None, Depends(get_optional_idempotency)]
ViewerUser = Annotated[User, Depends(require_role(UserRole.viewer))]
StreamViewerRequired = Depends(get_stream_viewer)
StreamGuardDep = Annotated[StreamGuard | None, Depends(get_stream_guard)]
MemberUser = Annotated[User, Depends(require_role(UserRole.member))]
AdminUser = Annotated[User, Depends(require_role(UserRole.admin))]
service_key_dependency = Depends(require_service_key)
