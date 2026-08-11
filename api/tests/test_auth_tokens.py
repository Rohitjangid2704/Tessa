import time
import uuid
from typing import Any

import httpx
import jwt
import pytest
from fastapi import FastAPI

from tessa_api.deps import AdminUser, MemberUser
from tessa_api.schemas.enums import UserRole
from tessa_api.settings import Settings
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration


def claims_for(settings: Settings, subject: uuid.UUID, **overrides: Any) -> dict[str, Any]:
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": settings.api_jwt_issuer,
        "aud": settings.api_jwt_audience,
        "sub": str(subject),
        "email": "someone@tessa.test",
        "role": "admin",
        "iat": now,
        "exp": now + 300,
        "jti": str(uuid.uuid4()),
    }
    claims.update(overrides)
    return {key: value for key, value in claims.items() if value is not None}


def sign(settings: Settings, claims: dict[str, Any], algorithm: str = "HS256") -> str:
    secret = settings.api_jwt_secret.get_secret_value() * (2 if algorithm == "HS512" else 1)
    return jwt.encode(claims, secret, algorithm=algorithm)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_valid_token_returns_the_user(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    user = await make_user(UserRole.member)
    response = await client.get("/api/v1/users/me", headers=auth_headers(user))
    assert response.status_code == 200
    assert response.json() == {
        "id": str(user.id),
        "email": user.email,
        "name": user.name,
        "role": "member",
    }


async def test_expired_token_is_token_expired(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user()
    now = int(time.time())
    token = sign(settings, claims_for(settings, user.id, iat=now - 400, exp=now - 100))
    response = await client.get("/api/v1/users/me", headers=bearer(token))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "token_expired"


async def test_leeway_accepts_barely_expired_and_rejects_clearly_expired(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user()
    now = int(time.time())
    barely = sign(settings, claims_for(settings, user.id, exp=now - 3))
    clearly = sign(settings, claims_for(settings, user.id, exp=now - 30))
    assert (await client.get("/api/v1/users/me", headers=bearer(barely))).status_code == 200
    assert (await client.get("/api/v1/users/me", headers=bearer(clearly))).status_code == 401


@pytest.mark.parametrize(
    "override",
    [
        {"aud": "someone-else"},
        {"iss": "someone-else"},
    ],
)
async def test_wrong_audience_or_issuer_is_unauthenticated(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings, override: dict[str, str]
) -> None:
    user = await make_user()
    token = sign(settings, claims_for(settings, user.id, **override))
    response = await client.get("/api/v1/users/me", headers=bearer(token))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


@pytest.mark.parametrize("missing", ["sub", "exp", "iat", "iss", "aud"])
async def test_missing_required_claim_is_unauthenticated(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings, missing: str
) -> None:
    user = await make_user()
    token = sign(settings, claims_for(settings, user.id, **{missing: None}))
    response = await client.get("/api/v1/users/me", headers=bearer(token))
    assert response.status_code == 401


async def test_wrong_signature_is_unauthenticated(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user()
    token = jwt.encode(
        claims_for(settings, user.id), "a-completely-different-secret-0123456789", "HS256"
    )
    response = await client.get("/api/v1/users/me", headers=bearer(token))
    assert response.status_code == 401


async def test_alg_none_is_rejected(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user()
    token = jwt.encode(claims_for(settings, user.id), "", algorithm="none")
    response = await client.get("/api/v1/users/me", headers=bearer(token))
    assert response.status_code == 401


async def test_wrong_algorithm_is_rejected(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user()
    token = sign(settings, claims_for(settings, user.id), algorithm="HS512")
    response = await client.get("/api/v1/users/me", headers=bearer(token))
    assert response.status_code == 401


async def test_subject_that_is_not_a_uuid_is_rejected(
    client: httpx.AsyncClient, settings: Settings
) -> None:
    token = sign(settings, claims_for(settings, uuid.uuid4(), sub="not-a-uuid"))
    response = await client.get("/api/v1/users/me", headers=bearer(token))
    assert response.status_code == 401


async def test_unknown_user_is_rejected(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    await make_user()
    token = sign(settings, claims_for(settings, uuid.uuid4()))
    response = await client.get("/api/v1/users/me", headers=bearer(token))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


async def test_inactive_user_is_rejected(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    user = await make_user(is_active=False)
    response = await client.get("/api/v1/users/me", headers=auth_headers(user))
    assert response.status_code == 401


async def test_database_role_wins_over_token_role(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user(UserRole.viewer)
    token = sign(settings, claims_for(settings, user.id, role="admin"))
    response = await client.get("/api/v1/users/me", headers=bearer(token))
    assert response.json()["role"] == "viewer"


async def test_missing_or_malformed_authorization_header(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user()
    token = sign(settings, claims_for(settings, user.id))
    for headers in (
        {},
        {"Authorization": f"Basic {token}"},
        {"Authorization": "Bearer "},
        {"Authorization": "Bearer not.a.jwt"},
        {"Authorization": token},
    ):
        response = await client.get("/api/v1/users/me", headers=headers)
        assert response.status_code == 401, headers


def add_role_routes(app: FastAPI) -> None:
    async def member_only(user: MemberUser) -> dict[str, str]:
        return {"role": user.role.value}

    async def admin_only(user: AdminUser) -> dict[str, str]:
        return {"role": user.role.value}

    app.add_api_route("/__test/member", member_only)
    app.add_api_route("/__test/admin", admin_only)


async def test_role_dependencies_follow_the_order_viewer_member_admin(
    app: FastAPI,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    add_role_routes(app)
    viewer = await make_user(UserRole.viewer)
    member = await make_user(UserRole.member)
    admin = await make_user(UserRole.admin)
    expectations = {
        "/__test/member": {viewer: 403, member: 200, admin: 200},
        "/__test/admin": {viewer: 403, member: 403, admin: 200},
    }
    for path, by_user in expectations.items():
        for user, expected in by_user.items():
            response = await client.get(path, headers=auth_headers(user))
            assert response.status_code == expected, (path, user.role)
            if expected == 403:
                assert response.json()["error"]["code"] == "role_required"
