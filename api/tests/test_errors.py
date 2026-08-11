import re
import uuid

import httpx
from fastapi import FastAPI

from tessa_api.errors import ApiError, dependency_unavailable

UUID7_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def add_failing_routes(app: FastAPI) -> None:
    async def explode() -> None:
        raise RuntimeError("secret-internal-detail")

    async def refuse() -> None:
        raise ApiError(409, "conflict", "state clash")

    async def missing_dependency() -> None:
        raise dependency_unavailable("temporal", "Temporal is not reachable")

    async def conflict_with_headers() -> None:
        raise ApiError(429, "rate_limited", "slow down", headers={"Retry-After": "7"})

    app.add_api_route("/__test/explode", explode)
    app.add_api_route("/__test/refuse", refuse)
    app.add_api_route("/__test/dependency", missing_dependency)
    app.add_api_route("/__test/headers", conflict_with_headers)


async def test_unauthenticated_envelope(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/users/me")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    error = response.json()["error"]
    assert error["code"] == "unauthenticated"
    assert error["details"] == []
    assert error["request_id"] == response.headers["x-request-id"]


async def test_not_found_envelope(client: httpx.AsyncClient) -> None:
    response = await client.get("/no/such/route")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert "detail" not in response.json()


async def test_method_not_allowed_envelope(client: httpx.AsyncClient) -> None:
    response = await client.post("/health")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method_not_allowed"
    assert "GET" in response.headers["allow"]


async def test_validation_envelope(client: httpx.AsyncClient) -> None:
    response = await client.get("/schemas/bundle.vabc.json")
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_failed"
    detail = error["details"][0]
    assert detail["loc"] == ["path", "version"]
    assert detail["code"] == "int_parsing"
    assert set(detail) == {"loc", "code", "message"}


async def test_validation_envelope_never_echoes_input(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/v1/auth/credentials/verify",
        json={"email": "x@y.z", "password": ""},
        headers={"X-Service-Key": "dev-only-test-service-key-0123456789abcdef"},
    )
    assert response.status_code == 422
    assert "x@y.z" not in response.text


async def test_unhandled_error_is_internal_error_without_trace(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    add_failing_routes(app)
    response = await client.get("/__test/explode")
    assert response.status_code == 500
    body = response.json()
    assert body["error"]["code"] == "internal_error"
    assert body["error"]["details"] == []
    assert body["error"]["request_id"] == response.headers["x-request-id"]
    assert "secret-internal-detail" not in response.text
    assert "Traceback" not in response.text


async def test_api_error_carries_status_code_and_message(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    add_failing_routes(app)
    response = await client.get("/__test/refuse")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"
    assert response.json()["error"]["message"] == "state clash"


async def test_api_error_headers_are_sent(app: FastAPI, client: httpx.AsyncClient) -> None:
    add_failing_routes(app)
    response = await client.get("/__test/headers")
    assert response.status_code == 429
    assert response.headers["retry-after"] == "7"


async def test_dependency_unavailable_names_the_dependency_in_code(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    add_failing_routes(app)
    response = await client.get("/__test/dependency")
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "dependency_unavailable"
    assert error["details"] == [
        {"loc": ["dependency"], "code": "temporal", "message": "Temporal is not reachable"}
    ]


async def test_request_id_is_echoed_when_valid(client: httpx.AsyncClient) -> None:
    response = await client.get("/health", headers={"X-Request-ID": "client-supplied-id-123"})
    assert response.headers["x-request-id"] == "client-supplied-id-123"


async def test_request_id_is_generated_as_uuid7(client: httpx.AsyncClient) -> None:
    response = await client.get("/health")
    request_id = response.headers["x-request-id"]
    assert UUID7_PATTERN.match(request_id)
    assert str(uuid.UUID(request_id)) == request_id


async def test_unsafe_request_id_is_replaced(client: httpx.AsyncClient) -> None:
    for unsafe in ("short", "has spaces in it 123", "x" * 129, "bad/char/id-12345"):
        response = await client.get("/health", headers={"X-Request-ID": unsafe})
        assert response.headers["x-request-id"] != unsafe
        assert UUID7_PATTERN.match(response.headers["x-request-id"])


async def test_request_id_is_in_error_body_when_supplied(client: httpx.AsyncClient) -> None:
    response = await client.get("/no/such/route", headers={"X-Request-ID": "trace-me-0001"})
    assert response.json()["error"]["request_id"] == "trace-me-0001"
    assert response.headers["x-request-id"] == "trace-me-0001"


async def test_cors_preflight_allows_configured_origin(client: httpx.AsyncClient) -> None:
    response = await client.options(
        "/api/v1/users/me",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,idempotency-key",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "access-control-allow-credentials" not in response.headers
    assert response.headers["access-control-max-age"] == "600"


async def test_cors_rejects_unknown_origin(client: httpx.AsyncClient) -> None:
    response = await client.get("/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in response.headers


async def test_cors_exposes_contract_headers(client: httpx.AsyncClient) -> None:
    response = await client.get("/health", headers={"Origin": "http://localhost:3000"})
    exposed = response.headers["access-control-expose-headers"].lower()
    for name in ("x-request-id", "idempotency-replayed", "retry-after", "content-disposition"):
        assert name in exposed


async def test_internal_error_still_carries_cors_headers(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    add_failing_routes(app)
    response = await client.get("/__test/explode", headers={"Origin": "http://localhost:3000"})
    assert response.status_code == 500
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
