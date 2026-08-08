from fastapi import APIRouter, Request

from tessa_api.auth.users import authenticate
from tessa_api.deps import LoginRateLimiterDep, SessionDep, service_key_dependency
from tessa_api.errors import ApiError, error_responses
from tessa_api.schemas.auth import AuthUser, CredentialsVerifyRequest

router = APIRouter(tags=["auth"])


@router.post(
    "/credentials/verify",
    response_model=AuthUser,
    summary="Verify email and password for the Auth.js credentials provider",
    dependencies=[service_key_dependency],
    responses=error_responses(401, 422, 429),
)
async def verify_credentials(
    body: CredentialsVerifyRequest,
    request: Request,
    session: SessionDep,
    limiter: LoginRateLimiterDep,
) -> AuthUser:
    client_ip = request.client.host if request.client else "unknown"
    limiter.check(body.email, client_ip)
    user = await authenticate(session, body.email, body.password)
    if user is None:
        limiter.record_failure(body.email, client_ip)
        raise ApiError(401, "invalid_credentials", "Invalid email or password")
    limiter.reset(body.email, client_ip)
    return AuthUser(id=user.id, email=user.email, name=user.name, role=user.role)
