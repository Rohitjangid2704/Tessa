from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from tessa_api import main
from tessa_api.main import create_app
from tests.support import settings_with, suite_env_values


async def test_docs_are_served_when_enabled(client: httpx.AsyncClient) -> None:
    assert (await client.get("/api/v1/docs")).status_code == 200
    assert (await client.get("/api/v1/openapi.json")).status_code == 200


async def test_docs_are_hidden_when_disabled_but_the_document_stays() -> None:
    app = create_app(settings_with(docs_enabled="false"))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
        assert (await http.get("/api/v1/docs")).status_code == 404
        assert (await http.get("/api/v1/openapi.json")).status_code == 200


async def test_openapi_document_is_served_from_the_prefixed_path(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get("/api/v1/openapi.json")
    assert response.json()["info"]["title"] == "Tessa API"
    assert "StreamEvent" in response.json()["components"]["schemas"]


async def test_large_responses_are_gzipped(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/openapi.json", headers={"Accept-Encoding": "gzip"})
    assert response.headers["content-encoding"] == "gzip"


async def test_small_responses_are_not_gzipped(client: httpx.AsyncClient) -> None:
    response = await client.get("/health", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in response.headers


async def test_root_and_health_shapes(client: httpx.AsyncClient) -> None:
    assert (await client.get("/")).json() == {"name": "Tessa API", "status": "ready"}
    assert (await client.get("/health")).json() == {"status": "ok"}


async def test_ingest_endpoint_is_hidden_but_guarded_by_the_service_key(
    client: httpx.AsyncClient,
) -> None:
    body = {
        "events": [
            {
                "type": "dashboard.invalidate",
                "payload": {},
                "occurred_at": "2026-09-30T14:03:22.123Z",
                "ephemeral": True,
            }
        ]
    }
    unauthenticated = await client.post("/internal/v1/run-events", json=body)
    assert unauthenticated.status_code == 401
    authenticated = await client.post(
        "/internal/v1/run-events",
        json=body,
        headers={"X-Service-Key": "dev-only-test-service-key-0123456789abcdef"},
    )
    assert authenticated.status_code == 200
    assert authenticated.json() == {"accepted": 1, "deduplicated": 0, "seqs": [None]}


async def test_ingest_batch_validation_requires_identity_for_durable_events(
    client: httpx.AsyncClient,
) -> None:
    durable_without_key = {
        "events": [{"type": "hello.tick", "payload": {}, "occurred_at": "2026-09-30T14:03:22Z"}]
    }
    ephemeral = {
        "events": [
            {
                "type": "dashboard.invalidate",
                "payload": {},
                "occurred_at": "2026-09-30T14:03:22Z",
                "ephemeral": True,
            }
        ]
    }
    headers = {"X-Service-Key": "dev-only-test-service-key-0123456789abcdef"}
    rejected = await client.post(
        "/internal/v1/run-events", json=durable_without_key, headers=headers
    )
    accepted_shape = await client.post("/internal/v1/run-events", json=ephemeral, headers=headers)
    assert rejected.status_code == 422
    assert accepted_shape.status_code == 200


def test_module_level_app_is_built_lazily_from_the_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    for key, value in suite_env_values().items():
        monkeypatch.setenv(key, value)
    monkeypatch.chdir(tmp_path)
    main.default_app.cache_clear()
    try:
        assert isinstance(main.app, FastAPI)
    finally:
        main.default_app.cache_clear()
