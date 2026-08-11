import hashlib
import importlib.util
import json
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from jsonschema import Draft202012Validator

from tessa_api.main import create_app
from tessa_api.schemas.registry import SchemaIndex
from tessa_api.services.schema_registry import (
    SCHEMA_CACHE_CONTROL,
    SCHEMA_CONTENT_TYPE,
    SCHEMAS,
    SchemaStore,
    build_schema_document,
    etag_matches,
    find_definition,
    render_committed_files,
)
from tests.support import API_ROOT, settings_with

SCHEMAS_ROOT = API_ROOT.parent / "schemas"
PUBLISHED_SCHEMAS = [
    ("bundle", 0),
    ("stream-event", 0),
    ("scenario", 2),
    ("probe", 4),
    ("finding", 5),
    ("persona", 7),
    ("goal", 7),
    ("mutant", 8),
    ("schedule", 8),
    ("report", 8),
    ("proposal", 11),
]
PUBLISHED_SCHEMA_FILES = [f"{name}.v1.json" for name, _ in PUBLISHED_SCHEMAS]
PUBLISHED_FILES = {*PUBLISHED_SCHEMA_FILES, "index.json"}
STREAM_EVENT_TYPES = {
    "stream.hello",
    "stream.replay_end",
    "stream.resync_required",
    "stream.heartbeat",
    "stream.closing",
    "stream.error",
    "hello.tick",
    "hello.laya",
    "run.created",
    "run.status_changed",
    "run.finished",
    "run.progress",
    "budget.updated",
    "budget.exhausted",
    "scenario.queued",
    "scenario.started",
    "scenario.verdict",
    "scenario.finished",
    "scenario.changed",
    "step.recorded",
    "step.graded",
    "browser_session.started",
    "browser_session.ended",
    "tile.frame",
    "seed.progress",
    "invariant.result",
    "finding.created",
    "finding.updated",
    "finding.occurrence_added",
    "coverage.updated",
    "explore.action",
    "explore.candidate",
    "explore.verified",
    "sim.turn",
    "sim.checked",
    "mutation.outcome",
    "notification.created",
    "dashboard.invalidate",
    "agent_session.changed",
    "proposal.updated",
}


def load_export_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "export_schemas_script", API_ROOT / "scripts" / "export_schemas.py"
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
async def https_client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(settings_with(public_api_url="https://tessa.example.com"))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            yield http


def test_the_root_schemas_folder_holds_exactly_the_published_files() -> None:
    assert {path.name for path in SCHEMAS_ROOT.iterdir()} == PUBLISHED_FILES


def test_committed_files_match_a_fresh_export_byte_for_byte() -> None:
    for file_name, content in render_committed_files().items():
        assert (SCHEMAS_ROOT / file_name).read_bytes() == content.encode("utf-8"), file_name


def test_committed_files_use_lf_and_end_with_a_newline() -> None:
    for file_name in PUBLISHED_FILES:
        data = (SCHEMAS_ROOT / file_name).read_bytes()
        assert b"\r\n" not in data
        assert data.endswith(b"\n")
        json.loads(data)


def test_export_script_check_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/export_schemas.py", "--check"],
        cwd=API_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_export_script_writes_then_reports_drift(tmp_path: Path) -> None:
    script = load_export_script()
    expected = render_committed_files()
    assert script.find_drift(expected, tmp_path) == [
        *(f"missing {file_name}" for file_name in PUBLISHED_SCHEMA_FILES),
        "missing index.json",
    ]
    script.write_files(expected, tmp_path)
    assert script.find_drift(expected, tmp_path) == []
    (tmp_path / "bundle.v1.json").write_text("{}\n", encoding="utf-8")
    (tmp_path / "stray.json").write_text("{}\n", encoding="utf-8")
    assert script.find_drift(expected, tmp_path) == [
        "out of date bundle.v1.json",
        "unexpected stray.json",
    ]


def test_committed_files_carry_a_relative_id_and_the_2020_12_dialect() -> None:
    for definition in SCHEMAS:
        document = json.loads((SCHEMAS_ROOT / definition.file_name).read_text(encoding="utf-8"))
        assert document["$id"] == definition.file_name
        assert document["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        Draft202012Validator.check_schema(document)


def test_committed_index_lists_relative_urls_and_hashes_of_the_committed_bytes() -> None:
    index = SchemaIndex.model_validate_json((SCHEMAS_ROOT / "index.json").read_text("utf-8"))
    assert [(entry.name, entry.version, entry.stage) for entry in index.schemas] == [
        (name, 1, stage) for name, stage in PUBLISHED_SCHEMAS
    ]
    for entry in index.schemas:
        committed = (SCHEMAS_ROOT / f"{entry.name}.v{entry.version}.json").read_bytes()
        assert entry.url == f"{entry.name}.v{entry.version}.json"
        assert entry.sha256 == hashlib.sha256(committed).hexdigest()


def test_registry_lookup_is_exact() -> None:
    assert find_definition("bundle", 1) is not None
    assert find_definition("stream-event", 1) is not None
    assert find_definition("bundle", 2) is None
    assert find_definition("scenario", 1) is not None
    assert find_definition("scenario", 2) is None


def test_every_registered_schema_is_a_valid_draft_2020_12_document() -> None:
    for definition in SCHEMAS:
        Draft202012Validator.check_schema(build_schema_document(definition))


@pytest.mark.parametrize(
    ("header", "matches"),
    [
        (None, False),
        ('"abc"', True),
        ('W/"abc"', True),
        ('"zzz", "abc"', True),
        ("*", True),
        ('"zzz"', False),
        ("", False),
    ],
)
def test_etag_comparison(header: str | None, matches: bool) -> None:
    assert etag_matches(header, '"abc"') is matches


async def test_index_is_public_and_lists_every_schema_with_absolute_urls(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get("/schemas/index.json")
    assert response.status_code == 200
    index = SchemaIndex.model_validate(response.json())
    assert [entry.name for entry in index.schemas] == [name for name, _ in PUBLISHED_SCHEMAS]
    assert [entry.url for entry in index.schemas] == [
        f"http://localhost:8000/schemas/{file_name}" for file_name in PUBLISHED_SCHEMA_FILES
    ]
    assert all(entry.version == 1 for entry in index.schemas)
    assert [entry.stage for entry in index.schemas] == [stage for _, stage in PUBLISHED_SCHEMAS]


async def test_index_sha256_is_over_the_served_bytes(client: httpx.AsyncClient) -> None:
    index = SchemaIndex.model_validate((await client.get("/schemas/index.json")).json())
    for entry in index.schemas:
        served = await client.get(f"/schemas/{entry.name}.v{entry.version}.json")
        assert entry.sha256 == hashlib.sha256(served.content).hexdigest()


@pytest.mark.parametrize("name", ["bundle", "stream-event", "scenario"])
async def test_schema_is_served_with_the_documented_headers(
    client: httpx.AsyncClient, name: str
) -> None:
    response = await client.get(f"/schemas/{name}.v1.json")
    assert response.status_code == 200
    assert response.headers["content-type"] == SCHEMA_CONTENT_TYPE
    assert response.headers["cache-control"] == SCHEMA_CACHE_CONTROL == "public, max-age=3600"
    digest = hashlib.sha256(response.content).hexdigest()
    assert response.headers["etag"] == f'"{digest}"'
    Draft202012Validator.check_schema(response.json())


@pytest.mark.parametrize("name", ["bundle", "stream-event", "scenario"])
async def test_served_id_equals_the_schema_url(client: httpx.AsyncClient, name: str) -> None:
    response = await client.get(f"/schemas/{name}.v1.json")
    assert response.json()["$id"] == f"http://localhost:8000/schemas/{name}.v1.json"


async def test_id_follows_the_public_api_url_without_touching_the_files(
    https_client: httpx.AsyncClient,
) -> None:
    before = (SCHEMAS_ROOT / "bundle.v1.json").read_bytes()
    document = (await https_client.get("/schemas/bundle.v1.json")).json()
    index = (await https_client.get("/schemas/index.json")).json()
    assert document["$id"] == "https://tessa.example.com/schemas/bundle.v1.json"
    assert index["schemas"][0]["url"] == "https://tessa.example.com/schemas/bundle.v1.json"
    assert (SCHEMAS_ROOT / "bundle.v1.json").read_bytes() == before


async def test_only_the_id_differs_between_environments(
    client: httpx.AsyncClient, https_client: httpx.AsyncClient
) -> None:
    local = (await client.get("/schemas/bundle.v1.json")).json()
    hosted = (await https_client.get("/schemas/bundle.v1.json")).json()
    local.pop("$id")
    hosted.pop("$id")
    assert local == hosted


async def test_etag_differs_when_the_id_differs(
    client: httpx.AsyncClient, https_client: httpx.AsyncClient
) -> None:
    local = await client.get("/schemas/bundle.v1.json")
    hosted = await https_client.get("/schemas/bundle.v1.json")
    assert local.headers["etag"] != hosted.headers["etag"]


async def test_etag_is_stable_across_requests(client: httpx.AsyncClient) -> None:
    first = await client.get("/schemas/stream-event.v1.json")
    second = await client.get("/schemas/stream-event.v1.json")
    assert first.headers["etag"] == second.headers["etag"]
    assert first.content == second.content


@pytest.mark.parametrize("make_header", [lambda tag: tag, lambda tag: f"W/{tag}", lambda tag: "*"])
async def test_matching_if_none_match_gives_304_without_a_body(
    client: httpx.AsyncClient, make_header: Any
) -> None:
    etag = (await client.get("/schemas/bundle.v1.json")).headers["etag"]
    response = await client.get(
        "/schemas/bundle.v1.json", headers={"If-None-Match": make_header(etag)}
    )
    assert response.status_code == 304
    assert response.content == b""
    assert response.headers["etag"] == etag
    assert response.headers["cache-control"] == SCHEMA_CACHE_CONTROL


async def test_if_none_match_with_a_list_matches_any_member(client: httpx.AsyncClient) -> None:
    etag = (await client.get("/schemas/bundle.v1.json")).headers["etag"]
    response = await client.get(
        "/schemas/bundle.v1.json", headers={"If-None-Match": f'"stale", {etag}'}
    )
    assert response.status_code == 304


async def test_stale_if_none_match_returns_the_document(client: httpx.AsyncClient) -> None:
    response = await client.get("/schemas/bundle.v1.json", headers={"If-None-Match": '"stale"'})
    assert response.status_code == 200
    assert response.json()["title"] == "Tessa bundle manifest"


async def test_etag_of_another_schema_does_not_match(client: httpx.AsyncClient) -> None:
    other = (await client.get("/schemas/stream-event.v1.json")).headers["etag"]
    response = await client.get("/schemas/bundle.v1.json", headers={"If-None-Match": other})
    assert response.status_code == 200


async def test_gzip_keeps_the_same_document_and_etag(client: httpx.AsyncClient) -> None:
    plain = await client.get("/schemas/bundle.v1.json")
    compressed = await client.get("/schemas/bundle.v1.json", headers={"Accept-Encoding": "gzip"})
    assert compressed.headers["content-encoding"] == "gzip"
    assert compressed.headers["etag"] == plain.headers["etag"]
    assert compressed.content == plain.content


@pytest.mark.parametrize("path", ["/schemas/bundle.v2.json", "/schemas/probe.v2.json"])
async def test_unknown_schema_is_not_found(client: httpx.AsyncClient, path: str) -> None:
    response = await client.get(path)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_schemas_need_no_authentication(client: httpx.AsyncClient) -> None:
    assert (await client.get("/schemas/index.json")).status_code == 200
    assert (await client.get("/schemas/bundle.v1.json")).status_code == 200


async def test_a_missing_schema_file_is_a_server_error_not_a_blank_document(
    tmp_path: Path,
) -> None:
    app: FastAPI = create_app(settings_with(schemas_dir=str(tmp_path)))
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
        response = await http.get("/schemas/bundle.v1.json")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"


def test_store_reads_from_the_configured_directory(tmp_path: Path) -> None:
    definition = find_definition("bundle", 1)
    assert definition is not None
    (tmp_path / definition.file_name).write_text('{"$id": "x", "type": "object"}', encoding="utf-8")
    served = SchemaStore(tmp_path, "https://example.test").serve(definition)
    assert json.loads(served.body) == {
        "$id": "https://example.test/schemas/bundle.v1.json",
        "type": "object",
    }
    assert served.sha256 == hashlib.sha256(served.body).hexdigest()
    assert served.etag == f'"{served.sha256}"'


async def test_stream_event_schema_lists_every_event_type(
    client: httpx.AsyncClient,
) -> None:
    document = (await client.get("/schemas/stream-event.v1.json")).json()
    assert len(STREAM_EVENT_TYPES) == 40
    assert set(document["discriminator"]["mapping"]) == STREAM_EVENT_TYPES


async def test_stream_event_schema_accepts_real_events_and_rejects_broken_ones(
    client: httpx.AsyncClient,
) -> None:
    document = (await client.get("/schemas/stream-event.v1.json")).json()
    validator = Draft202012Validator(document)
    good = {
        "type": "hello.tick",
        "run_id": "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11",
        "seq": 2,
        "ts": "2026-09-30T14:03:22.123Z",
        "payload": {"n": 1, "total": 5, "message": "tick 1"},
    }
    validator.validate(good)
    assert not validator.is_valid({**good, "payload": {"n": "one"}})
    assert not validator.is_valid({**good, "type": "no.such.event"})
    assert not validator.is_valid({key: value for key, value in good.items() if key != "ts"})
