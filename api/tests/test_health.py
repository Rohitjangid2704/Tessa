import asyncio
import time
from pathlib import Path

import httpx
import pytest
import respx
from fastapi import FastAPI

from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.main import create_app
from tessa_api.schemas.enums import DependencyStatus, UserRole
from tessa_api.services import health
from tessa_api.settings import Settings
from tests.support import AuthHeaders, MakeUser, settings_with

CLOSED_PORT_ADDRESS = "127.0.0.1:1"
CLOSED_PORT_URL = "http://127.0.0.1:1"
BROKEN_DATABASE_URL = "postgresql+asyncpg://tessa:x@127.0.0.1:1/tessa_test"


async def test_liveness_touches_no_dependency() -> None:
    broken = settings_with(
        database_url=BROKEN_DATABASE_URL,
        temporal_address=CLOSED_PORT_ADDRESS,
        laya_url=CLOSED_PORT_URL,
    )
    app = create_app(broken)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            response = await http.get("/health")
            root = await http.get("/")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert root.json() == {"name": "Tessa API", "status": "ready"}


async def test_dependencies_require_authentication(client: httpx.AsyncClient) -> None:
    response = await client.get("/health/dependencies")
    assert response.status_code == 401


@pytest.mark.integration
async def test_dependencies_report_stopped_services_without_failing(
    db_app: FastAPI,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    configured = settings_with(temporal_address=CLOSED_PORT_ADDRESS, laya_url=CLOSED_PORT_URL)
    app = create_app(configured)
    async with app.router.lifespan_context(app):
        viewer = await make_user(UserRole.viewer)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            started = time.perf_counter()
            response = await http.get("/health/dependencies", headers=auth_headers(viewer))
            elapsed = time.perf_counter() - started
            liveness = await http.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["db"]["status"] == "up"
    assert isinstance(body["db"]["latency_ms"], int)
    assert body["temporal"]["status"] == "down"
    assert body["temporal"]["latency_ms"] is None
    assert body["temporal"]["detail"]
    assert body["laya"]["status"] == "down"
    assert body["storage"]["status"] == "up"
    assert body["storage"]["detail"] == "writable"
    assert set(body) == {"db", "temporal", "laya", "storage"}
    assert liveness.status_code == 200
    assert elapsed < 2 * health.CHECK_TIMEOUT_SECONDS


@pytest.mark.integration
async def test_laya_unconfigured_when_url_is_empty(
    db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders, client: httpx.AsyncClient
) -> None:
    viewer = await make_user(UserRole.viewer)
    response = await client.get("/health/dependencies", headers=auth_headers(viewer))
    assert response.status_code == 200
    assert response.json()["laya"]["status"] == "unconfigured"


async def test_any_http_response_from_laya_counts_as_up() -> None:
    configured = settings_with(laya_url="http://laya.test")
    engine = create_engine(configured.database_url)
    try:
        with respx.mock:
            respx.get("http://laya.test").respond(404)
            result = await health.check_dependencies(configured, create_session_factory(engine))
    finally:
        await engine.dispose()
    assert result.laya.status is DependencyStatus.up
    assert result.laya.detail == "HTTP 404"


async def test_database_outage_is_reported_down_concurrently() -> None:
    broken = settings_with(database_url=BROKEN_DATABASE_URL, temporal_address=CLOSED_PORT_ADDRESS)
    engine = create_engine(broken.database_url)
    try:
        started = time.perf_counter()
        result = await health.check_dependencies(broken, create_session_factory(engine))
        elapsed = time.perf_counter() - started
    finally:
        await engine.dispose()
    assert result.db.status is DependencyStatus.down
    assert result.db.latency_ms is None
    assert result.temporal.status is DependencyStatus.down
    assert result.laya.status is DependencyStatus.unconfigured
    assert elapsed < 2 * health.CHECK_TIMEOUT_SECONDS


async def test_temporal_up_is_reported_with_latency(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    async def serving(address: str) -> None:
        return None

    monkeypatch.setattr(health, "probe_temporal", serving)
    engine = create_engine(settings.database_url)
    try:
        result = await health.check_dependencies(settings, create_session_factory(engine))
    finally:
        await engine.dispose()
    assert result.temporal.status is DependencyStatus.up
    assert result.temporal.latency_ms is not None


async def test_storage_up_creates_the_data_dir_and_leaves_no_probe_file(tmp_path: Path) -> None:
    data_dir = tmp_path / "nested" / "data"
    configured = settings_with(data_dir=data_dir)
    engine = create_engine(configured.database_url)
    try:
        result = await health.check_dependencies(configured, create_session_factory(engine))
    finally:
        await engine.dispose()
    assert result.storage.status is DependencyStatus.up
    assert result.storage.detail == "writable"
    assert data_dir.is_dir()
    assert list(data_dir.iterdir()) == []


async def test_storage_down_when_the_data_dir_is_not_writable(tmp_path: Path) -> None:
    blocked = tmp_path / "occupied"
    blocked.write_text("a file where the directory should be", encoding="utf-8")
    configured = settings_with(data_dir=blocked / "data")
    engine = create_engine(configured.database_url)
    try:
        result = await health.check_dependencies(configured, create_session_factory(engine))
    finally:
        await engine.dispose()
    assert result.storage.status is DependencyStatus.down
    assert result.storage.detail


async def test_slow_dependency_times_out(monkeypatch: pytest.MonkeyPatch) -> None:
    async def never() -> str | None:
        await asyncio.sleep(30)
        return None

    monkeypatch.setattr(health, "CHECK_TIMEOUT_SECONDS", 0.05)
    result = await health.run_check(never)
    assert result.status is DependencyStatus.down
    assert result.detail == "timed out after 0.05s"
