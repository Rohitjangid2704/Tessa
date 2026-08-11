import base64
import json
import time
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from fastapi import FastAPI

from tessa_api.ids import new_id
from tessa_api.schemas.enums import UserRole
from tessa_api.schemas.streams import WsTicket
from tessa_api.services.tickets import (
    TicketError,
    TicketRegistry,
    build_ws_url,
    issue_ticket,
    verify_ticket,
)
from tessa_api.settings import Settings
from tests.streams.support import make_event, new_run_id, post_events
from tests.support import AuthHeaders, MakeUser, settings_with


def ticket_claims(settings: Settings, **overrides: object) -> dict[str, object]:
    now = int(time.time())
    claims: dict[str, object] = {
        "typ": "ws-ticket",
        "sub": str(new_id()),
        "run_id": str(new_id()),
        "jti": str(new_id()),
        "iat": now,
        "exp": now + 30,
    }
    claims.update(overrides)
    return {key: value for key, value in claims.items() if value is not None}


def sign(settings: Settings, claims: dict[str, object], algorithm: str = "HS256") -> str:
    secret = settings.signing_key.get_secret_value() * (2 if algorithm == "HS512" else 1)
    return jwt.encode(claims, secret, algorithm=algorithm)


def unsigned_token(claims: dict[str, object]) -> str:
    def encode(part: dict[str, object]) -> str:
        return base64.urlsafe_b64encode(json.dumps(part).encode()).rstrip(b"=").decode()

    return f"{encode({'alg': 'none', 'typ': 'JWT'})}.{encode(claims)}."


def test_issued_ticket_carries_the_documented_claims(settings: Settings) -> None:
    user_id, run_id = new_id(), new_id()
    issued_at = datetime.now(UTC)
    ticket = issue_ticket(settings, user_id, run_id, issued_at)
    claims = jwt.decode(
        ticket.ticket, settings.signing_key.get_secret_value(), algorithms=["HS256"]
    )
    assert claims["typ"] == "ws-ticket"
    assert claims["sub"] == str(user_id)
    assert claims["run_id"] == str(run_id)
    assert uuid.UUID(claims["jti"])
    assert claims["exp"] - claims["iat"] == settings.ws_ticket_ttl_seconds
    assert ticket.expires_at == datetime.fromtimestamp(claims["exp"], UTC)


def test_every_ticket_has_its_own_jti(settings: Settings) -> None:
    user_id, run_id = new_id(), new_id()
    first = verify_ticket(settings, issue_ticket(settings, user_id, run_id).ticket)
    second = verify_ticket(settings, issue_ticket(settings, user_id, run_id).ticket)
    assert first.token_id != second.token_id


def test_ticket_is_signed_with_the_signing_key_not_the_api_secret(settings: Settings) -> None:
    ticket = issue_ticket(settings, new_id(), new_id()).ticket
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(ticket, settings.api_jwt_secret.get_secret_value(), algorithms=["HS256"])


def test_verify_returns_the_claims(settings: Settings) -> None:
    user_id, run_id = new_id(), new_id()
    claims = verify_ticket(settings, issue_ticket(settings, user_id, run_id).ticket)
    assert claims.user_id == user_id
    assert claims.run_id == run_id


def test_expired_ticket_is_reported_as_expired(settings: Settings) -> None:
    long_ago = datetime.now(UTC) - timedelta(minutes=5)
    ticket = issue_ticket(settings, new_id(), new_id(), long_ago).ticket
    with pytest.raises(TicketError) as raised:
        verify_ticket(settings, ticket)
    assert raised.value.reason == "ticket_expired"


def test_ticket_has_no_leeway_after_expiry(settings: Settings) -> None:
    now = int(time.time())
    token = sign(settings, ticket_claims(settings, iat=now - 31, exp=now - 1))
    with pytest.raises(TicketError):
        verify_ticket(settings, token)


@pytest.mark.parametrize("missing", ["typ", "sub", "run_id", "jti", "exp", "iat"])
def test_ticket_missing_a_required_claim_is_invalid(settings: Settings, missing: str) -> None:
    token = sign(settings, ticket_claims(settings, **{missing: None}))
    with pytest.raises(TicketError) as raised:
        verify_ticket(settings, token)
    assert raised.value.reason == "ticket_invalid"


def test_ticket_with_another_type_is_invalid(settings: Settings) -> None:
    token = sign(settings, ticket_claims(settings, typ="api-token"))
    with pytest.raises(TicketError):
        verify_ticket(settings, token)


def test_ticket_with_a_wrong_key_algorithm_or_none_is_invalid(settings: Settings) -> None:
    claims = ticket_claims(settings)
    forged = jwt.encode(claims, "another-secret-another-secret-0123456789", algorithm="HS256")
    wrong_algorithm = sign(settings, claims, algorithm="HS512")
    unsigned = unsigned_token(claims)
    for token in (forged, wrong_algorithm, unsigned, "garbage", ""):
        with pytest.raises(TicketError):
            verify_ticket(settings, token)


@pytest.mark.parametrize(
    "overrides", [{"sub": "not-a-uuid"}, {"run_id": "not-a-uuid"}, {"jti": 12345}]
)
def test_ticket_with_malformed_claim_values_is_invalid(
    settings: Settings, overrides: dict[str, object]
) -> None:
    token = sign(settings, ticket_claims(settings, **overrides))
    with pytest.raises(TicketError):
        verify_ticket(settings, token)


def test_registry_allows_one_use_per_jti() -> None:
    registry = TicketRegistry(clock=lambda: 100.0)
    assert registry.consume("a", 130) is True
    assert registry.consume("a", 130) is False
    assert registry.consume("b", 130) is True


def test_registry_forgets_a_jti_once_it_has_expired() -> None:
    now = 100.0
    registry = TicketRegistry(clock=lambda: now)
    registry.consume("a", 130)
    registry.consume("b", 160)
    assert registry.remembered() == 2
    now = 131.0
    registry.consume("c", 200)
    assert registry.remembered() == 2
    now = 1000.0
    registry.consume("d", 1030)
    assert registry.remembered() == 1


@pytest.mark.parametrize(
    ("public_url", "expected_prefix"),
    [
        ("http://localhost:8000", "ws://localhost:8000/ws/v1/runs/"),
        ("https://tessa.example.com", "wss://tessa.example.com/ws/v1/runs/"),
        ("https://example.com/tessa", "wss://example.com/tessa/ws/v1/runs/"),
    ],
)
def test_ws_url_swaps_the_scheme_and_keeps_host_and_path(
    public_url: str, expected_prefix: str
) -> None:
    run_id = new_id()
    url = build_ws_url(public_url, run_id, "abc.def.ghi")
    assert url == f"{expected_prefix}{run_id}?ticket=abc.def.ghi"


@pytest.mark.integration
async def test_endpoint_mints_a_ticket_for_a_run_with_events(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    settings: Settings,
) -> None:
    run_id = new_run_id()
    await post_events(client, settings, [make_event(run_id, "first")])
    user = await make_user(UserRole.viewer)
    before = datetime.now(UTC)
    response = await client.post(
        "/api/v1/ws-tickets", json={"run_id": str(run_id)}, headers=auth_headers(user)
    )
    assert response.status_code == 200
    body = WsTicket.model_validate(response.json())
    assert body.ws_url.startswith(f"ws://localhost:8000/ws/v1/runs/{run_id}?ticket=")
    assert body.ws_url.endswith(body.ticket)
    claims = verify_ticket(settings, body.ticket)
    assert claims.user_id == user.id
    assert claims.run_id == run_id
    remaining = (body.expires_at - before).total_seconds()
    assert settings.ws_ticket_ttl_seconds - 2 <= remaining <= settings.ws_ticket_ttl_seconds + 1


@pytest.mark.integration
async def test_endpoint_expiry_is_formatted_with_z_and_milliseconds(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    settings: Settings,
) -> None:
    run_id = new_run_id()
    await post_events(client, settings, [make_event(run_id, "first")])
    response = await client.post(
        "/api/v1/ws-tickets",
        json={"run_id": str(run_id)},
        headers=auth_headers(await make_user(UserRole.viewer)),
    )
    assert response.json()["expires_at"].endswith(".000Z")


@pytest.mark.integration
async def test_endpoint_returns_not_found_for_a_run_without_events(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    response = await client.post(
        "/api/v1/ws-tickets",
        json={"run_id": str(new_run_id())},
        headers=auth_headers(await make_user(UserRole.viewer)),
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


@pytest.mark.integration
@pytest.mark.parametrize("role", [UserRole.viewer, UserRole.member, UserRole.admin])
async def test_endpoint_is_open_to_every_role(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    settings: Settings,
    role: UserRole,
) -> None:
    run_id = new_run_id()
    await post_events(client, settings, [make_event(run_id, "first")])
    response = await client.post(
        "/api/v1/ws-tickets",
        json={"run_id": str(run_id)},
        headers=auth_headers(await make_user(role)),
    )
    assert response.status_code == 200


@pytest.mark.integration
async def test_endpoint_needs_a_bearer_token(client: httpx.AsyncClient, db_app: FastAPI) -> None:
    response = await client.post("/api/v1/ws-tickets", json={"run_id": str(new_run_id())})
    assert response.status_code == 401


@pytest.mark.integration
async def test_endpoint_refuses_inactive_users(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    user = await make_user(UserRole.viewer, is_active=False)
    response = await client.post(
        "/api/v1/ws-tickets", json={"run_id": str(new_run_id())}, headers=auth_headers(user)
    )
    assert response.status_code == 401


@pytest.mark.integration
async def test_endpoint_rejects_a_malformed_run_id(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    response = await client.post(
        "/api/v1/ws-tickets",
        json={"run_id": "nope"},
        headers=auth_headers(await make_user(UserRole.viewer)),
    )
    assert response.status_code == 422


def test_ticket_ttl_comes_from_settings() -> None:
    short = settings_with(ws_ticket_ttl_seconds="7")
    ticket = issue_ticket(short, new_id(), new_id())
    claims = jwt.decode(ticket.ticket, short.signing_key.get_secret_value(), algorithms=["HS256"])
    assert claims["exp"] - claims["iat"] == 7
