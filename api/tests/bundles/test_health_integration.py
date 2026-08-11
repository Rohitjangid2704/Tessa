from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from tessa_api.settings import Settings
from tests.bundle_fixtures import build_fixture
from tests.bundles.support import upload_zip
from tests.fake_target import FakeTargetServer, serve_fake_target
from tests.stage_one import environment_path

pytestmark = pytest.mark.integration


@pytest.fixture
def fake_target() -> Iterator[FakeTargetServer]:
    with serve_fake_target() as server:
        yield server


async def test_health_checks_read_the_stored_manifest_the_way_the_intake_wrote_it(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
    fake_target: FakeTargetServer,
    settings: Settings,
) -> None:
    uploaded = await upload_zip(client, member_headers, build_fixture("gracie_like", token))
    assert uploaded.status_code == 201
    dsn = settings.database_url.get_secret_value().replace("postgresql+asyncpg", "postgresql")
    patch = await client.patch(
        environment_path(target["id"]),
        json={
            "set": {"GRACIE_BASE_URL": fake_target.base_url, "TRUTH_DB_DSN": dsn},
            "clear": [],
        },
        headers=member_headers,
    )
    assert patch.status_code == 200
    checks = await client.post(
        f"/api/v1/targets/{target['id']}/health-checks", json={}, headers=member_headers
    )
    assert checks.status_code == 200, checks.text
    interfaces = {entry["interface_id"]: entry for entry in checks.json()["interfaces"]}
    assert set(interfaces) == {"chat_sse", "browser", "admin_api", "truth:primary_db"}
    assert interfaces["chat_sse"]["status"] == "ok"
    assert "GRACIE_BASE_URL" in interfaces["chat_sse"]["variables"]
    assert interfaces["browser"]["status"] == "ok"
    assert interfaces["admin_api"]["status"] == "ok"
    assert interfaces["truth:primary_db"]["status"] == "ok"
    requested = {path for path, _ in fake_target.requests}
    assert "/health" in requested
    assert "/" in requested
    assert not any(path.startswith("/api/") for path in requested)
