import io
import uuid
import zipfile

import httpx
import pytest
import yaml
from fastapi import FastAPI

from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import AdapterKind
from tessa_api.settings import Settings
from tessa_worker.checks.internal_ids import build_tier0_context
from tests.adapters.support import RegisteredTarget
from tests.fake_target.bundle import (
    BUNDLE_ROOT,
    DEFAULT_TARGET_TOKEN,
    build_bundle_zip,
    read_bundle_files,
    retarget,
)

EXPECTED_FILES = {
    "manifest.yaml",
    "README.md",
    "env.template",
    "flows/login_and_chat.yaml",
    "flows/confirm_create_issue.yaml",
    "seeds/reset.sh",
    "seeds/hash.sh",
}


def test_the_bundle_folder_holds_the_manifest_readme_env_template_flows_and_seeds() -> None:
    assert BUNDLE_ROOT.name == "tessa"
    assert set(read_bundle_files()) == EXPECTED_FILES


def test_the_zip_is_deterministic_and_keeps_the_tessa_prefix() -> None:
    assert build_bundle_zip() == build_bundle_zip()
    with zipfile.ZipFile(io.BytesIO(build_bundle_zip())) as archive:
        assert {name.removeprefix("tessa/") for name in archive.namelist()} == EXPECTED_FILES
        assert all(name.startswith("tessa/") for name in archive.namelist())


def test_retargeting_changes_only_the_target_token_line() -> None:
    token = "tgt_" + "b" * 22
    files = read_bundle_files()
    changed = retarget(files, token)
    assert changed["manifest.yaml"] != files["manifest.yaml"]
    assert f"target_token: {token}".encode() in changed["manifest.yaml"]
    assert {name: content for name, content in changed.items() if name != "manifest.yaml"} == {
        name: content for name, content in files.items() if name != "manifest.yaml"
    }
    assert DEFAULT_TARGET_TOKEN.encode() in files["manifest.yaml"]


def test_a_malformed_target_token_is_refused() -> None:
    with pytest.raises(ValueError, match="tgt_"):
        retarget(read_bundle_files(), "tgt_short")


async def test_the_bundle_uploads_through_the_real_intake_as_valid_and_above_the_bar(
    api_app: FastAPI,
    asgi_client: httpx.AsyncClient,
    api_settings: Settings,
    registered: RegisteredTarget,
) -> None:
    response = await asgi_client.get(
        f"/api/v1/bundles/{registered.bundle_id}", headers=registered.headers
    )
    assert response.status_code == 200
    bundle = response.json()
    assert bundle["validation_status"] == "valid"
    assert bundle["completeness"]["status"] == "meets_bar"
    assert bundle["completeness"]["score"] >= 80
    assert bundle["feature_count"] >= 2
    assert bundle["errors"] == []
    assert bundle["warnings"] == []


async def test_the_catalog_lists_the_features_with_examples(
    asgi_client: httpx.AsyncClient, registered: RegisteredTarget
) -> None:
    response = await asgi_client.get(
        "/api/v1/catalog",
        params={"target_id": str(registered.target_id)},
        headers=registered.headers,
    )
    assert response.status_code == 200
    items = [item for area in response.json()["areas"] for item in area["items"]]
    with_examples = [item for item in items if item["examples"]]
    assert len(with_examples) >= 2
    assert {item["feature_id"] for item in items} >= {
        "maintenance.read.open_issues",
        "rooms.read.dirty",
        "maintenance.write.create_issue",
    }


async def test_the_environment_is_reconciled_from_the_template_and_holds_the_set_values(
    asgi_client: httpx.AsyncClient, registered: RegisteredTarget
) -> None:
    response = await asgi_client.get(
        f"/api/v1/targets/{registered.target_id}/environment", headers=registered.headers
    )
    assert response.status_code == 200
    variables = {item["name"]: item for item in response.json()["items"]}
    assert set(variables) == {
        "FAKE_TARGET_URL",
        "STAFF_EMAIL",
        "STAFF_PASSWORD",
        "MANAGER_TOKEN",
        "ADMIN_TOKEN",
    }
    assert all(item["has_value"] for item in variables.values())
    assert variables["STAFF_PASSWORD"]["secret"] is True
    assert variables["STAFF_PASSWORD"].get("value") is None


async def test_a_second_upload_of_the_same_bundle_is_the_same_version(
    asgi_client: httpx.AsyncClient, registered: RegisteredTarget
) -> None:
    target = (
        await asgi_client.get(f"/api/v1/targets/{registered.target_id}", headers=registered.headers)
    ).json()
    again = await asgi_client.post(
        "/api/v1/bundles",
        files={
            "file": ("tessa.zip", build_bundle_zip(target["target_token"]), "application/zip")
        },
        headers={**registered.headers, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert again.status_code == 200
    assert again.json()["created"] is False


def test_the_manifest_declares_the_three_adapter_kinds_and_the_internal_id_pattern() -> None:
    manifest = BundleManifest.model_validate(yaml.safe_load(read_bundle_files()["manifest.yaml"]))
    assert {interface.kind for interface in manifest.interfaces} == {
        AdapterKind.sse,
        AdapterKind.http,
        AdapterKind.browser,
    }
    context = build_tier0_context(manifest)
    assert any("fake-session" in pattern for pattern in context.internal_id_patterns)
