from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from tessa_api.db.models import BundleRow, CatalogItemRow
from tessa_api.settings import Settings
from tests.bundle_fixtures import (
    LEAKED_DB_PASSWORD,
    LEAKED_GITHUB_TOKEN,
    build_fixture,
    minimal_valid,
)
from tests.bundles.support import (
    BUNDLES_PATH,
    new_key,
    staging_directories,
    stored_files,
    upload_paste,
    upload_zip,
)
from tests.stage_one import environment_path
from tests.zip_builder import ZipEntry, build_zip, zip_entries

pytestmark = pytest.mark.integration


async def count_rows(app: FastAPI, model: Any) -> int:
    async with app.state.session_factory() as session:
        return int(await session.scalar(select(func.count()).select_from(model)) or 0)


async def test_gracie_like_zip_creates_version_one(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
    settings: Settings,
) -> None:
    response = await upload_zip(
        client, member_headers, build_fixture("gracie_like", token), note="first upload"
    )
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["created"] is True
    assert result["dry_run_run_id"] is None
    bundle = result["bundle"]
    assert bundle["target_id"] == target["id"]
    assert bundle["version"] == 1
    assert bundle["source"] == "zip"
    assert bundle["note"] == "first upload"
    assert bundle["schema_version"] == 1
    assert bundle["validation_status"] == "valid"
    assert bundle["errors"] == []
    assert bundle["warnings"] == []
    assert bundle["feature_count"] == 4
    assert bundle["file_count"] == 8
    assert bundle["size_bytes"] > 0
    assert bundle["diff_summary"] is None
    assert bundle["scenarios_imported"] == 0
    assert bundle["mutants_imported"] == 0
    assert [hook["id"] for hook in bundle["hooks_missing"]] == ["pin_clock", "flush_cache"]
    completeness = bundle["completeness"]
    assert completeness["score"] == 100
    assert completeness["bar"] == 80
    assert completeness["status"] == "meets_bar"
    assert [check["id"] for check in completeness["checks"]] == [
        "required_sections",
        "feature_interface_roles",
        "feature_examples",
        "oracle_read_only",
        "env_template_coverage",
        "seeds_reset_and_hash",
    ]
    assert all(
        check["passed"] and check["earned"] == check["weight"] for check in completeness["checks"]
    )
    assert bundle["uploaded_at"].endswith("Z")
    stored = {path.name for path in stored_files(settings)}
    assert {"manifest.yaml", "env.template", "open_maintenance.sql", "reset.sql"} <= stored
    assert staging_directories(settings) == []


async def test_identical_reupload_returns_the_existing_version(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    token: str,
    db_app: FastAPI,
) -> None:
    data = build_fixture("gracie_like", token)
    first = await upload_zip(client, member_headers, data)
    second = await upload_zip(client, member_headers, data, note="a different note")
    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["created"] is False
    assert second.json()["bundle"]["id"] == first.json()["bundle"]["id"]
    assert second.json()["bundle"]["version"] == 1
    assert await count_rows(db_app, BundleRow) == 1
    assert await count_rows(db_app, CatalogItemRow) == 4


async def test_backslash_zip_has_the_same_hash_as_the_forward_slash_zip(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    first = await upload_zip(client, member_headers, build_fixture("gracie_like", token))
    second = await upload_zip(client, member_headers, build_fixture("backslash_paths", token))
    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["bundle"]["hash"] == first.json()["bundle"]["hash"]


async def test_same_idempotency_key_replays_the_original_response(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    key = new_key()
    data = build_fixture("minimal_valid", token)
    first = await upload_zip(client, member_headers, data, key=key)
    replay = await upload_zip(client, member_headers, data, key=key)
    assert first.status_code == 201
    assert replay.status_code == 201
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert replay.json() == first.json()


async def test_same_key_with_a_different_file_is_a_conflict(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    key = new_key()
    first = await upload_zip(client, member_headers, build_fixture("minimal_valid", token), key=key)
    other = await upload_zip(client, member_headers, build_fixture("gracie_like", token), key=key)
    assert first.status_code == 201
    assert other.status_code == 409
    assert other.json()["error"]["code"] == "idempotency_conflict"


async def test_same_key_with_a_different_note_is_a_conflict(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    key = new_key()
    data = build_fixture("minimal_valid", token)
    await upload_zip(client, member_headers, data, key=key, note="one")
    other = await upload_zip(client, member_headers, data, key=key, note="two")
    assert other.status_code == 409


async def test_changed_feature_appears_in_the_diff_of_version_two(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    first = await upload_zip(client, member_headers, build_fixture("gracie_like", token))
    second = await upload_zip(client, member_headers, build_fixture("gracie_like_changed", token))
    assert second.status_code == 201
    bundle = second.json()["bundle"]
    assert bundle["version"] == 2
    assert bundle["diff_summary"] == {
        "against_bundle_id": first.json()["bundle"]["id"],
        "against_version": 1,
        "features_added": 1,
        "features_removed": 0,
        "features_changed": 1,
    }
    diff = await client.get(f"{BUNDLES_PATH}/{bundle['id']}/diff", headers=member_headers)
    assert diff.status_code == 200
    body = diff.json()
    assert body["bundle_id"] == bundle["id"]
    assert body["against_bundle_id"] == first.json()["bundle"]["id"]
    by_id = {item["feature_id"]: item for item in body["features"]}
    assert by_id["smart_log.read.open_maintenance"]["change"] == "changed"
    assert by_id["smart_log.read.open_maintenance"]["fields_changed"] == ["description"]
    assert by_id["rooms.read.list"]["change"] == "added"
    assert by_id["rooms.read.list"]["before"] is None
    assert {item["section"] for item in body["sections"]} == {"features"}
    assert "1 feature added" in body["summary"]


async def test_secret_bearing_zip_is_refused_and_nothing_is_stored(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    token: str,
    settings: Settings,
    db_app: FastAPI,
) -> None:
    response = await upload_zip(client, member_headers, build_fixture("secret_bearing", token))
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "bundle_contains_secret"
    locations = {(detail["loc"][1], detail["code"]) for detail in error["details"]}
    assert ("env.template", "github_token") in locations
    assert ("seeds/hash.sh", "dsn_password") in locations
    assert all(
        detail["loc"][0] == "file" and isinstance(detail["loc"][2], int)
        for detail in error["details"]
    )
    assert LEAKED_GITHUB_TOKEN not in response.text
    assert LEAKED_DB_PASSWORD not in response.text
    assert await count_rows(db_app, BundleRow) == 0
    assert stored_files(settings) == []
    assert staging_directories(settings) == []


async def test_secret_in_a_pasted_manifest_is_refused(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str, db_app: FastAPI
) -> None:
    manifest = build_fixture("paste_only", token).decode() + f"\nnote_key: {LEAKED_GITHUB_TOKEN}\n"
    response = await upload_paste(client, member_headers, manifest)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "bundle_contains_secret"
    assert LEAKED_GITHUB_TOKEN not in response.text
    assert await count_rows(db_app, BundleRow) == 0


async def test_zip_slip_is_rejected_before_anything_is_written(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    token: str,
    settings: Settings,
    db_app: FastAPI,
) -> None:
    response = await upload_zip(client, member_headers, build_fixture("zip_slip", token))
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["code"] == "unsafe_path"
    assert await count_rows(db_app, BundleRow) == 0
    assert stored_files(settings) == []
    assert not (settings.data_dir.parent / "evil.txt").exists()


async def test_zip_bomb_is_413(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str, db_app: FastAPI
) -> None:
    response = await upload_zip(client, member_headers, build_fixture("zip_bomb", token))
    assert response.status_code == 413
    error = response.json()["error"]
    assert error["code"] == "payload_too_large"
    assert error["details"][0]["code"] == "compression_ratio_exceeded"
    assert await count_rows(db_app, BundleRow) == 0


async def test_invalid_bundle_is_stored_without_a_catalog(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
    settings: Settings,
) -> None:
    response = await upload_zip(
        client, member_headers, build_fixture("missing_sections", target["target_token"])
    )
    assert response.status_code == 201, response.text
    bundle = response.json()["bundle"]
    assert bundle["validation_status"] == "invalid"
    assert bundle["feature_count"] == 0
    assert {error["pointer"] for error in bundle["errors"]} >= {
        "/interfaces",
        "/roles",
        "/features",
        "/environment",
    }
    assert all(
        error["severity"] == "error" and error["file"] == "manifest.yaml"
        for error in bundle["errors"]
    )
    assert bundle["completeness"]["status"] == "below_bar"
    assert bundle["completeness"]["score"] < 20
    assert await count_rows(db_app, CatalogItemRow) == 0
    assert any(path.name == "manifest.yaml" for path in stored_files(settings))
    environment = await client.get(environment_path(target["id"]), headers=member_headers)
    assert environment.json() == {"items": [], "missing_required": 0}


async def test_below_bar_minimal_bundle_is_valid_with_a_catalog(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    token: str,
    db_app: FastAPI,
) -> None:
    response = await upload_zip(client, member_headers, build_fixture("minimal_valid", token))
    assert response.status_code == 201
    bundle = response.json()["bundle"]
    assert bundle["validation_status"] == "valid"
    assert bundle["completeness"]["score"] == 70
    assert bundle["completeness"]["status"] == "below_bar"
    failed = [check for check in bundle["completeness"]["checks"] if not check["passed"]]
    assert {check["id"] for check in failed} == {"oracle_read_only", "seeds_reset_and_hash"}
    assert all(check["fix_hint"] for check in failed)
    assert await count_rows(db_app, CatalogItemRow) == 1


async def test_pasted_manifest_scores_below_the_bar(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
    settings: Settings,
) -> None:
    manifest = build_fixture("paste_only", target["target_token"]).decode()
    response = await upload_paste(client, member_headers, manifest, note="pasted")
    assert response.status_code == 201, response.text
    bundle = response.json()["bundle"]
    assert bundle["source"] == "manifest_paste"
    assert bundle["validation_status"] == "valid"
    assert bundle["completeness"]["score"] == 55
    assert bundle["completeness"]["status"] == "below_bar"
    assert bundle["file_count"] == 1
    assert bundle["feature_count"] == 4
    assert await count_rows(db_app, CatalogItemRow) == 4
    assert [path.name for path in stored_files(settings)] == ["manifest.yaml"]
    environment = await client.get(environment_path(target["id"]), headers=member_headers)
    names = {item["name"] for item in environment.json()["items"]}
    assert {"GRACIE_BASE_URL", "TRUTH_DB_DSN", "ADMIN_TOKEN"} <= names


async def test_paste_and_paste_again_is_identical(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    manifest = build_fixture("paste_only", token).decode()
    first = await upload_paste(client, member_headers, manifest)
    again = await upload_paste(client, member_headers, manifest.replace("\n", "\r\n"))
    assert first.status_code == 201
    assert again.status_code == 200
    assert again.json()["created"] is False


async def test_paste_with_a_syntax_error_and_no_target_id_is_422(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await upload_paste(client, member_headers, "a: [1, 2\n")
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["code"] == "yaml_syntax"


async def test_paste_with_a_syntax_error_and_a_target_id_is_stored_as_invalid(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    response = await upload_paste(client, member_headers, "a: [1, 2\n", target_id=target["id"])
    assert response.status_code == 201
    bundle = response.json()["bundle"]
    assert bundle["validation_status"] == "invalid"
    assert bundle["errors"][0]["code"] == "yaml_syntax"
    assert bundle["errors"][0]["line"] is not None


async def test_pasted_manifest_larger_than_the_limit_is_413(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    huge = f"target_token: {token}\nfiller: " + "x" * (1024 * 1024 + 10)
    response = await upload_paste(client, member_headers, huge)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


async def test_zip_without_a_manifest(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    data = zip_entries([ZipEntry("README.md", b"# nothing here\n")])
    refused = await upload_zip(client, member_headers, data)
    assert refused.status_code == 422
    assert refused.json()["error"]["details"][0]["code"] == "manifest_missing"
    kept = await upload_zip(client, member_headers, data, target_id=target["id"])
    assert kept.status_code == 201
    assert kept.json()["bundle"]["validation_status"] == "invalid"
    assert kept.json()["bundle"]["errors"][0]["code"] == "manifest_missing"


async def test_binary_entries_are_dropped_with_a_warning(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    files: dict[str, str | bytes] = dict(minimal_valid(token))
    files["logo.png"] = b"\x89PNG\r\n\x1a\n\x00\x00\x00"
    response = await upload_zip(client, member_headers, build_zip(files))
    assert response.status_code == 201
    warnings = response.json()["bundle"]["warnings"]
    assert [(warning["code"], warning["file"]) for warning in warnings] == [
        ("file_ignored", "logo.png")
    ]
