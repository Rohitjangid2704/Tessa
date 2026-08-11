import ipaddress
import time
import uuid
from collections.abc import Awaitable, Callable, Iterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic import SecretStr

from tessa_api.main import create_app
from tessa_api.schemas.enums import HealthCheckStatus, UserRole
from tessa_api.schemas.health import HealthReport, HealthReportInterface
from tessa_api.services.environment import DeclaredVariable
from tessa_api.services.health_checks import (
    CheckOutcome,
    DestinationRefused,
    combine,
    describe_exception,
    ensure_allowed_destination,
    is_blocked_address,
    merge_reports,
    overall_status,
    postgres_dsn,
    redact,
    resolve_http_targets,
    substitute_placeholders,
)
from tessa_api.settings import Settings
from tests.fake_target import FakeTargetServer, serve_fake_target
from tests.stage_one import TARGETS_PATH, create_target, environment_path, insert_bundle
from tests.stage_one import sample_manifest as build_manifest
from tests.support import AuthHeaders, MakeUser, settings_with
from tests.test_environment import reconcile

CHECKS_PATH = "/api/v1/targets/{target_id}/health-checks"
HEALTH_PATH = "/api/v1/targets/{target_id}/health"


@pytest.fixture
def fake_target() -> Iterator[FakeTargetServer]:
    with serve_fake_target() as server:
        yield server


def manifest_with_interfaces() -> dict[str, Any]:
    return build_manifest(
        interfaces=[
            {"id": "api", "kind": "http", "base_path": "/api", "health_endpoint": "/health"},
            {"id": "chat", "kind": "sse", "base_path": "/chat"},
            {"id": "ui", "kind": "browser", "base_path": "/"},
            {"id": "socket", "kind": "websocket", "base_path": "/ws"},
        ],
        truth_sources=[{"id": "main_db", "kind": "database", "connection_env": "TRUTH_DSN"}],
    )


def compose_dsn(settings: Settings) -> str:
    return settings.database_url.get_secret_value().replace("postgresql+asyncpg", "postgresql")


class Scenario:
    def __init__(
        self,
        app: FastAPI,
        client: httpx.AsyncClient,
        headers: dict[str, str],
        target_id: str,
        uploader: uuid.UUID,
    ) -> None:
        self.app = app
        self.client = client
        self.headers = headers
        self.target_id = target_id
        self.uploader = uploader

    async def declare(
        self, manifest: dict[str, Any], *variables: DeclaredVariable, version: int = 1
    ) -> None:
        await insert_bundle(self.app, self.target_id, self.uploader, manifest, version=version)
        await reconcile(self.app, self.target_id, *variables)

    async def set_values(self, values: dict[str, str]) -> None:
        response = await self.client.patch(
            environment_path(self.target_id), json={"set": values}, headers=self.headers
        )
        assert response.status_code == 200, response.text

    async def check(self, interface_ids: list[str] | None = None) -> httpx.Response:
        body = {} if interface_ids is None else {"interface_ids": interface_ids}
        return await self.client.post(
            CHECKS_PATH.format(target_id=self.target_id), json=body, headers=self.headers
        )

    async def entries(self, interface_ids: list[str] | None = None) -> dict[str, dict[str, Any]]:
        response = await self.check(interface_ids)
        assert response.status_code == 200, response.text
        return {entry["interface_id"]: entry for entry in response.json()["interfaces"]}


ScenarioFactory = Callable[..., Awaitable[Scenario]]


@pytest.fixture
async def make_scenario(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> ScenarioFactory:
    async def build(app: FastAPI | None = None) -> Scenario:
        member = await make_user(UserRole.member)
        headers = auth_headers(member)
        target = await create_target(client, headers)
        if app is None:
            return Scenario(db_app, client, headers, target["id"], member.id)
        transport = httpx.ASGITransport(app=app)
        other = httpx.AsyncClient(transport=transport, base_url="http://testserver")
        return Scenario(app, other, headers, target["id"], member.id)

    return build


def web_variables(extra: tuple[DeclaredVariable, ...] = ()) -> tuple[DeclaredVariable, ...]:
    return (
        DeclaredVariable(
            "QA_URL", kind="url", secret=False, interfaces=("api", "chat", "ui", "socket")
        ),
        DeclaredVariable("TRUTH_DSN", kind="dsn"),
        *extra,
    )


@pytest.mark.integration
async def test_every_supported_interface_is_green_against_a_local_target_and_postgres(
    make_scenario: ScenarioFactory, fake_target: FakeTargetServer, settings: Settings
) -> None:
    scenario = await make_scenario()
    await scenario.declare(manifest_with_interfaces(), *web_variables())
    await scenario.set_values({"QA_URL": fake_target.base_url, "TRUTH_DSN": compose_dsn(settings)})

    response = await scenario.check()
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["target_id"] == scenario.target_id
    assert report["checked_at"].endswith("Z")
    assert [entry["interface_id"] for entry in report["interfaces"]] == [
        "api",
        "chat",
        "ui",
        "socket",
        "truth:main_db",
    ]
    entries = {entry["interface_id"]: entry for entry in report["interfaces"]}
    for interface_id in ("api", "chat", "ui", "truth:main_db"):
        assert entries[interface_id]["status"] == "ok", entries[interface_id]
        assert isinstance(entries[interface_id]["latency_ms"], int)
    assert entries["api"]["message"] == "HTTP 200"
    assert entries["api"]["kind"] == "http"
    assert entries["api"]["variables"] == ["QA_URL"]
    assert entries["chat"]["kind"] == "sse"
    assert entries["truth:main_db"]["kind"] == "truth_source"
    assert entries["truth:main_db"]["variables"] == ["TRUTH_DSN"]
    assert entries["truth:main_db"]["message"] == "SELECT 1 succeeded"
    assert entries["socket"]["status"] == "skipped"
    assert "websocket" in entries["socket"]["message"]

    paths = dict(fake_target.requests)
    assert "/health" in paths
    assert paths["/chat"] == "text/event-stream"
    assert "/" in paths


@pytest.mark.integration
async def test_the_stored_report_is_read_back_and_feeds_the_target_summary(
    make_scenario: ScenarioFactory, fake_target: FakeTargetServer, settings: Settings
) -> None:
    scenario = await make_scenario()
    before = await scenario.client.get(
        HEALTH_PATH.format(target_id=scenario.target_id), headers=scenario.headers
    )
    assert before.status_code == 200
    assert before.json() == {"target_id": scenario.target_id, "checked_at": None, "interfaces": []}
    await scenario.declare(manifest_with_interfaces(), *web_variables())
    await scenario.set_values({"QA_URL": fake_target.base_url, "TRUTH_DSN": compose_dsn(settings)})
    posted = await scenario.check()
    stored = await scenario.client.get(
        HEALTH_PATH.format(target_id=scenario.target_id), headers=scenario.headers
    )
    assert stored.json() == posted.json()
    listed = await scenario.client.get(TARGETS_PATH, headers=scenario.headers)
    assert listed.json()["items"][0]["health"] == "ok"


@pytest.mark.integration
async def test_a_failing_interface_turns_the_target_health_failed(
    make_scenario: ScenarioFactory, fake_target: FakeTargetServer
) -> None:
    scenario = await make_scenario()
    manifest = build_manifest(
        interfaces=[
            {"id": "api", "kind": "http", "base_path": "/api", "health_endpoint": "/bad"},
            {"id": "ui", "kind": "browser", "base_path": "/"},
        ]
    )
    await scenario.declare(
        manifest,
        DeclaredVariable("QA_URL", kind="url", secret=False, interfaces=("api", "ui")),
    )
    await scenario.set_values({"QA_URL": fake_target.base_url})
    entries = await scenario.entries()
    assert entries["api"]["status"] == "failed"
    assert entries["api"]["message"] == "HTTP 500, expected 2xx"
    assert entries["ui"]["status"] == "ok"
    listed = await scenario.client.get(TARGETS_PATH, headers=scenario.headers)
    assert listed.json()["items"][0]["health"] == "failed"


@pytest.mark.integration
@pytest.mark.parametrize(
    ("path", "status", "message"),
    [
        ("/missing", "ok", "HTTP 404"),
        ("/unavailable", "failed", "HTTP 503, expected below 500"),
        ("/redirect", "ok", "HTTP 302"),
    ],
)
async def test_without_a_health_endpoint_the_base_url_only_has_to_answer_below_500(
    make_scenario: ScenarioFactory,
    fake_target: FakeTargetServer,
    path: str,
    status: str,
    message: str,
) -> None:
    scenario = await make_scenario()
    manifest = build_manifest(interfaces=[{"id": "api", "kind": "http", "base_path": path}])
    await scenario.declare(
        manifest, DeclaredVariable("QA_URL", kind="url", secret=False, interfaces=("api",))
    )
    await scenario.set_values({"QA_URL": fake_target.base_url})
    entry = (await scenario.entries())["api"]
    assert (entry["status"], entry["message"]) == (status, message)
    assert [path for path, _ in fake_target.requests] == [path]


@pytest.mark.integration
async def test_a_closed_port_fails_and_a_missing_value_is_skipped_with_a_message(
    make_scenario: ScenarioFactory,
) -> None:
    scenario = await make_scenario()
    manifest = build_manifest(
        interfaces=[
            {"id": "dead", "kind": "http", "base_path": "/"},
            {"id": "unset", "kind": "http", "base_path": "/"},
        ]
    )
    await scenario.declare(
        manifest,
        DeclaredVariable("DEAD_URL", kind="url", secret=False, interfaces=("dead",)),
        DeclaredVariable("UNSET_URL", kind="url", secret=False, interfaces=("unset",)),
        DeclaredVariable("UNLINKED_URL", kind="url", secret=False),
    )
    await scenario.set_values(
        {"DEAD_URL": "http://127.0.0.1:1", "UNLINKED_URL": "http://127.0.0.1:1"}
    )
    entries = await scenario.entries()
    assert entries["dead"]["status"] == "failed"
    assert entries["dead"]["message"] == "Connection refused or host unreachable"
    assert entries["unset"]["status"] == "skipped"
    assert "No value set for UNSET_URL" in entries["unset"]["message"]
    environment = await scenario.client.get(
        environment_path(scenario.target_id), headers=scenario.headers
    )
    health = {item["name"]: item["health"] for item in environment.json()["items"]}
    assert health["DEAD_URL"]["status"] == "failed"
    assert health["DEAD_URL"]["checked_at"].endswith("Z")
    assert health["UNSET_URL"]["status"] == "skipped"
    assert health["UNLINKED_URL"]["status"] == "unchecked"


@pytest.mark.integration
async def test_interface_without_any_url_variable_is_skipped(
    make_scenario: ScenarioFactory,
) -> None:
    scenario = await make_scenario()
    manifest = build_manifest(interfaces=[{"id": "api", "kind": "http", "base_path": "/api"}])
    await scenario.declare(manifest)
    entry = (await scenario.entries())["api"]
    assert entry["status"] == "skipped"
    assert entry["message"] == "No URL variable with a value is linked to this interface"
    assert entry["variables"] == []


@pytest.mark.integration
@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254",
        "http://169.254.1.1:8080",
        "http://[fd00:ec2::254]",
        "http://metadata.google.internal",
    ],
)
async def test_the_cloud_metadata_address_is_refused(
    make_scenario: ScenarioFactory, url: str
) -> None:
    scenario = await make_scenario()
    manifest = build_manifest(interfaces=[{"id": "api", "kind": "http", "base_path": "/"}])
    await scenario.declare(
        manifest, DeclaredVariable("QA_URL", kind="url", secret=False, interfaces=("api",))
    )
    await scenario.set_values({"QA_URL": url})
    started = time.perf_counter()
    entry = (await scenario.entries())["api"]
    assert time.perf_counter() - started < 5
    assert entry["status"] == "failed"
    assert entry["message"] == "The cloud metadata address is not checked"
    assert entry["latency_ms"] is None


@pytest.mark.integration
async def test_non_http_schemes_are_refused_for_http_interfaces(
    make_scenario: ScenarioFactory,
) -> None:
    scenario = await make_scenario()
    manifest = build_manifest(interfaces=[{"id": "api", "kind": "http", "base_path": "/"}])
    await scenario.declare(
        manifest, DeclaredVariable("QA_URL", kind="url", secret=False, interfaces=("api",))
    )
    await scenario.set_values({"QA_URL": "ftp://127.0.0.1:21/pub"})
    entry = (await scenario.entries())["api"]
    assert entry["status"] == "failed"
    assert entry["message"] == "Only http and https URLs are checked"


@pytest.mark.integration
async def test_placeholders_in_the_base_path_are_filled_from_the_environment(
    make_scenario: ScenarioFactory, fake_target: FakeTargetServer
) -> None:
    scenario = await make_scenario()
    manifest = build_manifest(
        interfaces=[
            {
                "id": "api",
                "kind": "http",
                "base_path": "${EDGE_URL}/api",
                "health_endpoint": "health",
            }
        ]
    )
    await scenario.declare(manifest, DeclaredVariable("EDGE_URL", kind="url", secret=False))
    entry = (await scenario.entries())["api"]
    assert entry["status"] == "skipped"
    assert entry["message"] == "No value set for EDGE_URL"
    await scenario.set_values({"EDGE_URL": fake_target.base_url})
    entry = (await scenario.entries())["api"]
    assert entry["status"] == "ok"
    assert [path for path, _ in fake_target.requests] == ["/api/health"]


@pytest.mark.integration
async def test_postgres_checks_report_failures_skips_and_never_the_password(
    make_scenario: ScenarioFactory, settings: Settings
) -> None:
    scenario = await make_scenario()
    manifest = build_manifest(
        truth_sources=[
            {"id": "wrong_password", "kind": "database", "connection_env": "WRONG_DSN"},
            {"id": "mysql", "kind": "database", "connection_env": "MYSQL_DSN"},
            {
                "id": "mongo",
                "kind": "database",
                "dialect": "mongodb",
                "connection_env": "MONGO_DSN",
            },
            {"id": "dead", "kind": "database", "connection_env": "DEAD_DSN"},
            {"id": "metadata", "kind": "database", "connection_env": "META_DSN"},
            {"id": "plain", "kind": "database", "connection_env": "PLAIN_DSN"},
        ]
    )
    await scenario.declare(
        manifest,
        *(
            DeclaredVariable(name, kind="dsn")
            for name in ("WRONG_DSN", "MYSQL_DSN", "MONGO_DSN", "DEAD_DSN", "META_DSN", "PLAIN_DSN")
        ),
    )
    healthy = settings.database_url.get_secret_value()
    wrong = healthy.replace("dev-only-tessa-postgres-password", "Wr0ng-Passw0rd-xyz")
    await scenario.set_values(
        {
            "WRONG_DSN": wrong.replace("postgresql+asyncpg", "postgresql"),
            "MYSQL_DSN": "mysql://reader:My5ql-Secret@127.0.0.1:3306/app",
            "MONGO_DSN": "mongodb://reader:Mong0-Secret@127.0.0.1:27017/app",
            "DEAD_DSN": "postgresql://reader:Dead-Secret-1@127.0.0.1:1/app",
            "META_DSN": "postgresql://reader:Meta-Secret-1@169.254.169.254:5432/app",
            "PLAIN_DSN": healthy,
        }
    )
    response = await scenario.check()
    assert response.status_code == 200, response.text
    entries = {entry["interface_id"]: entry for entry in response.json()["interfaces"]}
    assert entries["truth:wrong_password"]["status"] == "failed"
    assert entries["truth:mysql"]["status"] == "skipped"
    assert (
        entries["truth:mysql"]["message"]
        == "Only Postgres connections are checked, this one is mysql"
    )
    assert entries["truth:mongo"]["status"] == "skipped"
    assert entries["truth:mongo"]["message"] == "Only Postgres is checked, not mongodb"
    assert entries["truth:dead"]["status"] == "failed"
    assert entries["truth:metadata"]["message"] == "The cloud metadata address is not checked"
    assert entries["truth:plain"]["status"] == "ok"
    for secret in ("Wr0ng-Passw0rd", "My5ql-Secret", "Mong0-Secret", "Dead-Secret", "Meta-Secret"):
        assert secret not in response.text
    assert "dev-only-tessa-postgres-password" not in response.text


@pytest.mark.integration
async def test_a_read_endpoint_truth_source_is_checked_over_http(
    make_scenario: ScenarioFactory, fake_target: FakeTargetServer
) -> None:
    scenario = await make_scenario()
    manifest = build_manifest(
        truth_sources=[{"id": "api_truth", "kind": "read_endpoint", "connection_env": "TRUTH_URL"}]
    )
    await scenario.declare(manifest, DeclaredVariable("TRUTH_URL", kind="url"))
    await scenario.set_values({"TRUTH_URL": f"{fake_target.base_url}/missing"})
    entry = (await scenario.entries())["truth:api_truth"]
    assert (entry["status"], entry["kind"], entry["message"]) == ("ok", "truth_source", "HTTP 404")


@pytest.mark.integration
async def test_a_slow_target_times_out_at_the_configured_limit(
    make_scenario: ScenarioFactory, fake_target: FakeTargetServer, db_app: FastAPI
) -> None:
    app = create_app(settings_with(health_check_timeout_seconds=1))
    async with app.router.lifespan_context(app):
        scenario = await make_scenario(app)
        try:
            manifest = build_manifest(
                interfaces=[
                    {"id": "api", "kind": "http", "base_path": "/", "health_endpoint": "/sleepy"}
                ]
            )
            await scenario.declare(
                manifest, DeclaredVariable("QA_URL", kind="url", secret=False, interfaces=("api",))
            )
            await scenario.set_values({"QA_URL": fake_target.base_url})
            started = time.perf_counter()
            entry = (await scenario.entries())["api"]
            elapsed = time.perf_counter() - started
        finally:
            await scenario.client.aclose()
    assert entry["status"] == "failed"
    assert entry["message"] == "Timed out after 1s"
    assert elapsed < 2.5


async def run_slow_checks(
    make_scenario: ScenarioFactory, fake_target: FakeTargetServer, concurrency: int
) -> float:
    app = create_app(settings_with(health_check_concurrency=concurrency))
    async with app.router.lifespan_context(app):
        scenario = await make_scenario(app)
        try:
            names = ("one", "two", "three", "four")
            manifest = build_manifest(
                interfaces=[
                    {"id": name, "kind": "http", "base_path": "/", "health_endpoint": "/slow"}
                    for name in names
                ]
            )
            await scenario.declare(
                manifest,
                DeclaredVariable("QA_URL", kind="url", secret=False, interfaces=names),
            )
            await scenario.set_values({"QA_URL": fake_target.base_url})
            started = time.perf_counter()
            entries = await scenario.entries()
            elapsed = time.perf_counter() - started
        finally:
            await scenario.client.aclose()
    assert {entry["status"] for entry in entries.values()} == {"ok"}
    return elapsed


@pytest.mark.integration
async def test_checks_run_concurrently_up_to_the_configured_semaphore(
    make_scenario: ScenarioFactory, db_app: FastAPI
) -> None:
    results: dict[int, tuple[int, float]] = {}
    for concurrency in (1, 8):
        with serve_fake_target() as server:
            elapsed = await run_slow_checks(make_scenario, server, concurrency)
            results[concurrency] = (server.max_inflight, elapsed)
    assert results[1][0] == 1
    assert results[8][0] >= 2
    assert results[1][1] > results[8][1]


@pytest.mark.integration
async def test_a_subset_check_merges_into_the_stored_report_and_unknown_ids_are_rejected(
    make_scenario: ScenarioFactory, fake_target: FakeTargetServer, settings: Settings
) -> None:
    scenario = await make_scenario()
    await scenario.declare(manifest_with_interfaces(), *web_variables())
    await scenario.set_values({"QA_URL": fake_target.base_url, "TRUTH_DSN": compose_dsn(settings)})
    await scenario.entries()
    fake_target.requests.clear()
    subset = await scenario.entries(["api"])
    assert [path for path, _ in fake_target.requests] == ["/health"]
    assert list(subset) == ["api", "chat", "ui", "socket", "truth:main_db"]
    assert subset["chat"]["status"] == "ok"
    rejected = await scenario.check(["api", "ghost", "truth:ghost"])
    assert rejected.status_code == 422
    details = rejected.json()["error"]["details"]
    assert [(d["loc"], d["code"]) for d in details] == [
        (["body", "interface_ids", 1], "unknown_interface"),
        (["body", "interface_ids", 2], "unknown_interface"),
    ]


@pytest.mark.integration
async def test_health_checks_need_a_valid_bundle_and_use_the_latest_valid_one(
    make_scenario: ScenarioFactory, fake_target: FakeTargetServer, db_app: FastAPI
) -> None:
    scenario = await make_scenario()
    empty = await scenario.check()
    assert empty.status_code == 409
    assert empty.json()["error"]["code"] == "target_not_ready"
    await insert_bundle(db_app, scenario.target_id, scenario.uploader, None, version=1, valid=False)
    still_empty = await scenario.check()
    assert still_empty.status_code == 409
    await scenario.declare(
        build_manifest(interfaces=[{"id": "ui", "kind": "browser", "base_path": "/"}]),
        DeclaredVariable("QA_URL", kind="url", secret=False, interfaces=("ui",)),
        version=2,
    )
    await insert_bundle(db_app, scenario.target_id, scenario.uploader, None, version=3, valid=False)
    await scenario.set_values({"QA_URL": fake_target.base_url})
    entries = await scenario.entries()
    assert list(entries) == ["ui"]


@pytest.mark.integration
async def test_viewer_cannot_run_checks_but_can_read_them_and_unknown_targets_404(
    make_scenario: ScenarioFactory,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    scenario = await make_scenario()
    viewer = auth_headers(await make_user(UserRole.viewer))
    denied = await client.post(
        CHECKS_PATH.format(target_id=scenario.target_id), json={}, headers=viewer
    )
    allowed = await client.get(HEALTH_PATH.format(target_id=scenario.target_id), headers=viewer)
    missing = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11"
    assert denied.status_code == 403
    assert allowed.status_code == 200
    assert (
        await client.post(CHECKS_PATH.format(target_id=missing), json={}, headers=viewer)
    ).status_code == 403
    assert (
        await client.post(CHECKS_PATH.format(target_id=missing), json={}, headers=scenario.headers)
    ).status_code == 404
    assert (
        await client.get(HEALTH_PATH.format(target_id=missing), headers=viewer)
    ).status_code == 404


@pytest.mark.integration
async def test_the_request_body_may_be_omitted(
    make_scenario: ScenarioFactory, fake_target: FakeTargetServer
) -> None:
    scenario = await make_scenario()
    await scenario.declare(
        build_manifest(interfaces=[{"id": "ui", "kind": "browser", "base_path": "/"}]),
        DeclaredVariable("QA_URL", kind="url", secret=False, interfaces=("ui",)),
    )
    await scenario.set_values({"QA_URL": fake_target.base_url})
    response = await scenario.client.post(
        CHECKS_PATH.format(target_id=scenario.target_id), headers=scenario.headers
    )
    assert response.status_code == 200
    assert response.json()["interfaces"][0]["status"] == "ok"


def test_redact_replaces_secret_values_and_ignores_short_ones() -> None:
    secrets = {"ADMIN_TOKEN": SecretStr("tok_live_abcdef"), "FLAG": SecretStr("ab")}
    redacted = redact("failed with tok_live_abcdef for ab", secrets)
    assert redacted == "failed with ${ADMIN_TOKEN} for ab"


def test_redact_truncates_long_messages() -> None:
    assert len(redact("x" * 1000, {})) == 300


def test_describe_exception_names_the_error_type() -> None:
    assert describe_exception(ValueError("bad thing")) == "ValueError: bad thing"
    assert describe_exception(RuntimeError()) == "RuntimeError"
    assert (
        describe_exception(httpx.ConnectError("nope")) == "Connection refused or host unreachable"
    )


@pytest.mark.parametrize(
    ("address", "blocked"),
    [
        ("169.254.169.254", True),
        ("169.254.0.1", True),
        ("fe80::1", True),
        ("fd00:ec2::254", True),
        ("::ffff:169.254.169.254", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("192.168.0.10", False),
        ("93.184.216.34", False),
        ("::1", False),
    ],
)
def test_blocked_addresses(address: str, blocked: bool) -> None:
    assert is_blocked_address(ipaddress.ip_address(address)) is blocked


async def test_destination_check_blocks_names_literals_and_empty_hosts() -> None:
    for host in (
        "169.254.169.254",
        "metadata.google.internal",
        "METADATA.GOOGLE.INTERNAL.",
        None,
        "",
    ):
        with pytest.raises(DestinationRefused):
            await ensure_allowed_destination(host)
    for host in ("127.0.0.1", "localhost", "10.0.0.5", "[::1]"):
        await ensure_allowed_destination(host)


def test_postgres_dsn_accepts_driver_suffixes_and_refuses_other_engines() -> None:
    assert postgres_dsn("postgresql+asyncpg://u:p@h:5432/d") == "postgresql://u:p@h:5432/d"
    assert postgres_dsn("postgres://u:p@h/d") == "postgresql://u:p@h/d"
    assert postgres_dsn("postgresql+psycopg://u:p@h/d") == "postgresql://u:p@h/d"
    assert postgres_dsn("mysql://u:p@h/d") is None
    assert postgres_dsn("not a dsn") is None


def test_placeholders_report_the_first_missing_name() -> None:
    values = {"A_URL": SecretStr("http://a")}
    assert substitute_placeholders("${A_URL}/x", values) == ("http://a/x", None)
    assert substitute_placeholders("${A_URL}${B_URL}${C_URL}", values) == (
        "http://a${B_URL}${C_URL}",
        "B_URL",
    )


@pytest.mark.parametrize(
    ("interface", "linked", "expected"),
    [
        ({"base_path": "/api"}, ["http://h:1"], ("http://h:1/api", None)),
        ({"base_path": "/api"}, ["http://h:1/"], ("http://h:1/api", None)),
        ({"base_path": ""}, ["http://h:1"], ("http://h:1", None)),
        (
            {"base_path": "/api", "health_endpoint": "/health"},
            ["http://h:1"],
            ("http://h:1/api", "http://h:1/health"),
        ),
        (
            {"base_path": "/api", "health_endpoint": "health"},
            ["http://h:1"],
            ("http://h:1/api", "http://h:1/api/health"),
        ),
        (
            {"base_path": "https://other:2/v1", "health_endpoint": "/up"},
            [],
            ("https://other:2/v1", "https://other:2/up"),
        ),
    ],
)
def test_http_targets_join_origin_base_path_and_health_endpoint(
    interface: dict[str, Any], linked: list[str], expected: tuple[str, str | None]
) -> None:
    assert resolve_http_targets(interface, linked, {}) == expected


def test_http_targets_are_skipped_without_a_url() -> None:
    result = resolve_http_targets({"base_path": "/api"}, [], {})
    assert isinstance(result, CheckOutcome)
    assert result.status is HealthCheckStatus.skipped


def test_combine_prefers_failed_over_ok_over_skipped() -> None:
    skipped = CheckOutcome(HealthCheckStatus.skipped, None, "no value")
    ok = CheckOutcome(HealthCheckStatus.ok, 12, "HTTP 200")
    failed = CheckOutcome(HealthCheckStatus.failed, 40, "HTTP 500")
    assert combine([skipped, ok]).status is HealthCheckStatus.ok
    combined = combine([skipped, ok, failed])
    assert combined.status is HealthCheckStatus.failed
    assert combined.latency_ms == 40
    assert combined.message == "no value; HTTP 200; HTTP 500"
    assert combine([]).status is HealthCheckStatus.skipped


def test_overall_status_of_a_stored_report() -> None:
    def report(*statuses: str) -> dict[str, Any]:
        return {"interfaces": [{"status": status} for status in statuses]}

    assert overall_status(None) is HealthCheckStatus.unchecked
    assert overall_status(report()) is HealthCheckStatus.unchecked
    assert overall_status(report("skipped")) is HealthCheckStatus.skipped
    assert overall_status(report("skipped", "ok")) is HealthCheckStatus.ok
    assert overall_status(report("ok", "failed")) is HealthCheckStatus.failed


def test_merge_keeps_unchecked_entries_in_manifest_order_and_drops_removed_ones() -> None:
    def entry(name: str, status: HealthCheckStatus) -> HealthReportInterface:
        return HealthReportInterface(interface_id=name, kind="http", status=status, variables=[])

    previous = HealthReport(
        target_id=uuid.uuid4(),
        checked_at=None,
        interfaces=[
            entry("b", HealthCheckStatus.ok),
            entry("gone", HealthCheckStatus.ok),
            entry("a", HealthCheckStatus.failed),
        ],
    )
    merged = merge_reports(previous, {"a": entry("a", HealthCheckStatus.ok)}, ["a", "b", "c"])
    assert [(item.interface_id, item.status) for item in merged] == [
        ("a", HealthCheckStatus.ok),
        ("b", HealthCheckStatus.ok),
    ]
