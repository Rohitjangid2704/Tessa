import asyncio
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from tessa_api.db.models import BundleRow, CatalogItemRow
from tessa_api.services.storage import StorageBundleStore
from tessa_api.settings import Settings
from tests.bundle_fixtures import Files, build_fixture, gracie_like, minimal_valid, mutate_manifest
from tests.bundles.support import (
    new_key,
    staging_directories,
    stored_files,
    upload_zip,
)
from tests.zip_builder import build_zip

pytestmark = pytest.mark.integration

CONCURRENT_UPLOADS = 6


async def stored_versions(app: FastAPI) -> list[int]:
    async with app.state.session_factory() as session:
        rows = await session.scalars(select(BundleRow.version).order_by(BundleRow.version))
        return list(rows.all())


async def row_count(app: FastAPI, model: Any) -> int:
    async with app.state.session_factory() as session:
        return int(await session.scalar(select(func.count()).select_from(model)) or 0)


def distinct_gracie(token: str, number: int) -> bytes:
    files: dict[str, str | bytes] = dict(gracie_like(token))
    files["README.md"] = f"# Gracie test bundle, edition {number}\n"
    return build_zip(files, prefix="tessa/")


async def test_concurrent_uploads_get_distinct_consecutive_versions(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    token: str,
    db_app: FastAPI,
) -> None:
    responses = await asyncio.gather(
        *(
            upload_zip(client, member_headers, distinct_gracie(token, number))
            for number in range(CONCURRENT_UPLOADS)
        )
    )
    assert [response.status_code for response in responses] == [201] * CONCURRENT_UPLOADS
    versions = sorted(response.json()["bundle"]["version"] for response in responses)
    assert versions == list(range(1, CONCURRENT_UPLOADS + 1))
    assert await stored_versions(db_app) == versions
    assert await row_count(db_app, CatalogItemRow) == 4 * CONCURRENT_UPLOADS


async def test_concurrent_identical_uploads_create_exactly_one_version(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    token: str,
    db_app: FastAPI,
    settings: Settings,
) -> None:
    data = build_fixture("gracie_like", token)
    responses = await asyncio.gather(
        *(upload_zip(client, member_headers, data) for _ in range(CONCURRENT_UPLOADS))
    )
    statuses = sorted(response.status_code for response in responses)
    assert statuses == [200] * (CONCURRENT_UPLOADS - 1) + [201]
    assert len({response.json()["bundle"]["id"] for response in responses}) == 1
    assert sum(1 for response in responses if response.json()["created"]) == 1
    assert await stored_versions(db_app) == [1]
    assert await row_count(db_app, CatalogItemRow) == 4
    assert staging_directories(settings) == []
    assert len([path for path in stored_files(settings) if path.name == "manifest.yaml"]) == 1


async def test_a_failing_store_leaves_no_row_and_no_files(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    token: str,
    db_app: FastAPI,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken_commit(self: StorageBundleStore, staged: Any, version: int) -> str:
        raise OSError("disk full")

    monkeypatch.setattr(StorageBundleStore, "commit", broken_commit)
    response = await upload_zip(client, member_headers, build_fixture("gracie_like", token))
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert await row_count(db_app, BundleRow) == 0
    assert stored_files(settings) == []
    assert staging_directories(settings) == []


async def test_a_failure_after_the_files_moved_removes_them_again(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    token: str,
    db_app: FastAPI,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken_catalog(*arguments: Any, **keywords: Any) -> list[Any]:
        raise RuntimeError("catalog builder failed")

    monkeypatch.setattr("tessa_api.services.bundle_intake.catalog_rows", broken_catalog)
    response = await upload_zip(client, member_headers, build_fixture("gracie_like", token))
    assert response.status_code == 500
    assert await row_count(db_app, BundleRow) == 0
    assert stored_files(settings) == []
    assert staging_directories(settings) == []
    monkeypatch.undo()
    retry = await upload_zip(client, member_headers, build_fixture("gracie_like", token))
    assert retry.status_code == 201
    assert retry.json()["bundle"]["version"] == 1


async def test_a_failed_request_releases_its_idempotency_key(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    key = new_key()
    refused = await upload_zip(client, member_headers, b"not a zip", key=key)
    assert refused.status_code == 422
    retried = await upload_zip(
        client, member_headers, build_fixture("minimal_valid", token), key=key
    )
    assert retried.status_code == 201
    assert "Idempotency-Replayed" not in retried.headers


def improved_minimal(token: str) -> Files:
    files = dict(minimal_valid(token))

    def add_oracle_and_seeds(document: dict[str, Any]) -> None:
        document["features"][0]["examples"][0]["oracle"] = "note_count"
        document["truth_sources"] = [
            {
                "id": "notes_db",
                "kind": "database",
                "connection_env": "NOTES_DB_DSN",
                "dialect": "postgres",
            }
        ]
        document["seeds"] = {
            "reset_script": "seeds/reset.sql",
            "hash_command": "bash seeds/hash.sh",
            "dsn_env": "NOTES_SEED_DSN",
        }
        document["environment"].extend(
            [
                {"name": "NOTES_DB_DSN", "kind": "dsn", "secret": True, "purpose": "Read-only"},
                {"name": "NOTES_SEED_DSN", "kind": "dsn", "secret": True, "purpose": "Seed writes"},
            ]
        )

    files = mutate_manifest(files, add_oracle_and_seeds)
    files["env.template"] += (
        b"# Read-only connection\nNOTES_DB_DSN=<read-only-dsn>\n"
        b"# Seed connection\nNOTES_SEED_DSN=<write-dsn>\n"
    )
    files["oracle/note_count.sql"] = b"SELECT count(*) AS notes FROM note"
    files["oracle/note_count.yaml"] = (
        b"name: note_count\nfeature_ids: [notes.read.list]\nlanguage: sql\ntruth_source: notes_db\n"
        b"params_schema:\n  type: object\n  properties: {}\n"
        b"sentence_template: '{{ rows[0].notes }} notes'\n"
    )
    files["seeds/reset.sql"] = b"DELETE FROM note;\nINSERT INTO note (id) VALUES (1);\n"
    files["seeds/hash.sh"] = b"echo seed-hash-0001\n"
    return files


async def test_below_bar_bundle_gets_a_fixup_prompt_that_raises_the_score_when_followed(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    first = await upload_zip(client, member_headers, build_fixture("minimal_valid", token))
    bundle = first.json()["bundle"]
    assert bundle["completeness"]["status"] == "below_bar"
    prompt = await client.post(
        f"/api/v1/targets/{target['id']}/prompt-issues",
        json={"template_name": "fixup", "bundle_id": bundle["id"]},
        headers=member_headers,
    )
    assert prompt.status_code == 201, prompt.text
    text = prompt.json()["text"]
    assert token in text
    assert "oracle_read_only" in text
    assert "seeds_reset_and_hash" in text
    assert "seeds.reset_script" in text
    assert "70 out of 100" in text
    for check in bundle["completeness"]["checks"]:
        if not check["passed"]:
            assert check["fix_hint"] in text
    second = await upload_zip(client, member_headers, build_zip(improved_minimal(token)))
    assert second.status_code == 201, second.text
    improved = second.json()["bundle"]
    assert improved["errors"] == []
    assert improved["version"] == 2
    assert improved["completeness"]["score"] == 100
    assert improved["completeness"]["score"] > bundle["completeness"]["score"]
    assert improved["completeness"]["status"] == "meets_bar"
    assert improved["diff_summary"]["against_version"] == 1
    again = await client.post(
        f"/api/v1/targets/{target['id']}/prompt-issues",
        json={"template_name": "fixup", "bundle_id": improved["id"]},
        headers=member_headers,
    )
    assert again.status_code == 201
    assert "Nothing is open" in again.json()["text"]


async def test_invalid_bundle_fixup_lists_the_errors_with_pointers_and_lines(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    upload = await upload_zip(client, member_headers, build_fixture("missing_sections", token))
    bundle = upload.json()["bundle"]
    prompt = await client.post(
        f"/api/v1/targets/{target['id']}/prompt-issues",
        json={"template_name": "fixup", "bundle_id": bundle["id"]},
        headers=member_headers,
    )
    assert prompt.status_code == 201
    text = prompt.json()["text"]
    assert "manifest.yaml, /interfaces" in text
    assert "missing" in text
    assert "required_sections" in text
