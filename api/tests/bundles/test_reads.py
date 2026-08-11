import uuid
from typing import Any

import httpx
import pytest

from tests.bundle_fixtures import build_fixture, gracie_like_changed, minimal_valid
from tests.bundles.support import (
    BUNDLES_PATH,
    bundle_path,
    target_bundles_path,
    upload_zip,
)
from tests.stage_one import TARGETS_PATH
from tests.zip_builder import build_zip

pytestmark = pytest.mark.integration


async def upload_ok(
    client: httpx.AsyncClient, headers: dict[str, str], data: bytes, status: int = 201
) -> dict[str, Any]:
    response = await upload_zip(client, headers, data)
    assert response.status_code == status, response.text
    bundle: dict[str, Any] = response.json()["bundle"]
    return bundle


async def test_version_list_is_newest_first_and_paginates(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any], token: str
) -> None:
    first = await upload_ok(client, member_headers, build_fixture("minimal_valid", token))
    second = await upload_ok(client, member_headers, build_fixture("gracie_like", token))
    third = await upload_ok(client, member_headers, build_fixture("missing_sections", token))
    listing = await client.get(
        target_bundles_path(target["id"]), params={"include_total": "true"}, headers=member_headers
    )
    assert listing.status_code == 200
    body = listing.json()
    assert [item["version"] for item in body["items"]] == [3, 2, 1]
    assert body["total"] == 3
    assert body["next_cursor"] is None
    summary = body["items"][1]
    assert summary == {
        "id": second["id"],
        "version": 2,
        "hash": second["hash"],
        "source": "zip",
        "validation_status": "valid",
        "completeness_score": 100,
        "completeness_status": "meets_bar",
        "feature_count": 4,
        "uploaded_at": second["uploaded_at"],
    }
    assert body["items"][2]["completeness_status"] == "below_bar"
    assert body["items"][0]["validation_status"] == "invalid"
    assert third["version"] == 3
    assert first["version"] == 1
    page = await client.get(
        target_bundles_path(target["id"]), params={"limit": 2}, headers=member_headers
    )
    assert [item["version"] for item in page.json()["items"]] == [3, 2]
    cursor = page.json()["next_cursor"]
    assert cursor
    rest = await client.get(
        target_bundles_path(target["id"]),
        params={"limit": 2, "cursor": cursor},
        headers=member_headers,
    )
    assert [item["version"] for item in rest.json()["items"]] == [1]
    ascending = await client.get(
        target_bundles_path(target["id"]), params={"sort": "version"}, headers=member_headers
    )
    assert [item["version"] for item in ascending.json()["items"]] == [1, 2, 3]


async def test_version_list_rejects_unknown_sort_and_unknown_target(
    client: httpx.AsyncClient, viewer_headers: dict[str, str], target: dict[str, Any]
) -> None:
    bad = await client.get(
        target_bundles_path(target["id"]), params={"sort": "hash"}, headers=viewer_headers
    )
    assert bad.status_code == 422
    missing = await client.get(target_bundles_path(str(uuid.uuid4())), headers=viewer_headers)
    assert missing.status_code == 404


async def test_bundle_detail_matches_the_upload_response(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    token: str,
) -> None:
    uploaded = await upload_ok(client, member_headers, build_fixture("gracie_like", token))
    detail = await client.get(bundle_path(uploaded["id"]), headers=viewer_headers)
    assert detail.status_code == 200
    assert detail.json() == uploaded
    missing = await client.get(bundle_path(str(uuid.uuid4())), headers=viewer_headers)
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"


async def test_files_are_listed_and_previewed(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    uploaded = await upload_ok(client, member_headers, build_fixture("gracie_like", token))
    listing = await client.get(bundle_path(uploaded["id"], "files"), headers=member_headers)
    assert listing.status_code == 200
    items = listing.json()["items"]
    paths = [item["path"] for item in items]
    assert paths == sorted(paths)
    assert "manifest.yaml" in paths
    assert "oracle/open_maintenance.sql" in paths
    manifest_entry = next(item for item in items if item["path"] == "manifest.yaml")
    assert manifest_entry["size_bytes"] > 0
    assert len(manifest_entry["sha256"]) == 64
    content = await client.get(
        bundle_path(uploaded["id"], "files", "oracle/open_maintenance.sql"), headers=member_headers
    )
    assert content.status_code == 200
    body = content.json()
    assert body["path"] == "oracle/open_maintenance.sql"
    assert body["truncated"] is False
    assert body["content"].startswith("SELECT r.room_number AS room")
    manifest = await client.get(
        bundle_path(uploaded["id"], "files", "manifest.yaml"), headers=member_headers
    )
    assert f"target_token: {token}" in manifest.json()["content"]
    assert "\r" not in manifest.json()["content"]


async def test_unknown_or_unsafe_file_paths_are_404(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    uploaded = await upload_ok(client, member_headers, build_fixture("minimal_valid", token))
    unsafe = ("nope.txt", "..%2fmanifest.yaml", "seeds%2f..%2fmanifest.yaml", "%2e%2e/etc/passwd")
    for path in unsafe:
        response = await client.get(
            bundle_path(uploaded["id"], "files", path), headers=member_headers
        )
        assert response.status_code == 404, path


async def test_large_files_are_truncated_at_one_mebibyte(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    files: dict[str, str | bytes] = dict(minimal_valid(token))
    files["big.txt"] = "".join(
        f"line {index} abcdefghijklmnopqrstuvwxyz\n" for index in range(60_000)
    )
    uploaded = await upload_ok(client, member_headers, build_zip(files))
    response = await client.get(
        bundle_path(uploaded["id"], "files", "big.txt"), headers=member_headers
    )
    body = response.json()
    assert body["truncated"] is True
    assert len(body["content"].encode()) <= 1024 * 1024


async def test_diff_defaults_to_the_previous_valid_version_and_skips_invalid_ones(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    first = await upload_ok(client, member_headers, build_fixture("gracie_like", token))
    invalid = await upload_ok(client, member_headers, build_fixture("missing_sections", token))
    third = await upload_ok(client, member_headers, build_fixture("gracie_like_changed", token))
    assert invalid["validation_status"] == "invalid"
    assert third["version"] == 3
    assert third["diff_summary"]["against_bundle_id"] == first["id"]
    assert third["diff_summary"]["against_version"] == 1
    diff = await client.get(bundle_path(third["id"], "diff"), headers=member_headers)
    assert diff.json()["against_bundle_id"] == first["id"]
    assert [item["feature_id"] for item in diff.json()["features"]] == [
        "rooms.read.list",
        "smart_log.read.open_maintenance",
    ]
    invalid_diff = await client.get(bundle_path(invalid["id"], "diff"), headers=member_headers)
    assert invalid_diff.json()["against_bundle_id"] == first["id"]
    assert invalid_diff.json()["summary"].startswith("Compared with version 1")


async def test_diff_against_an_explicit_bundle(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    first = await upload_ok(client, member_headers, build_fixture("gracie_like", token))
    second = await upload_ok(client, member_headers, build_fixture("gracie_like_changed", token))
    reverse = await client.get(
        bundle_path(first["id"], "diff"), params={"against": second["id"]}, headers=member_headers
    )
    assert reverse.status_code == 200
    body = reverse.json()
    assert body["against_bundle_id"] == second["id"]
    changes = {item["feature_id"]: item["change"] for item in body["features"]}
    assert changes == {"rooms.read.list": "removed", "smart_log.read.open_maintenance": "changed"}
    itself = await client.get(
        bundle_path(first["id"], "diff"), params={"against": first["id"]}, headers=member_headers
    )
    assert itself.json()["features"] == []
    assert itself.json()["summary"] == "No differences from version 1."


async def test_first_version_has_no_diff(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    first = await upload_ok(client, member_headers, build_fixture("gracie_like", token))
    diff = await client.get(bundle_path(first["id"], "diff"), headers=member_headers)
    assert diff.status_code == 200
    assert diff.json() == {
        "bundle_id": first["id"],
        "against_bundle_id": None,
        "features": [],
        "sections": [],
        "summary": "There is no earlier valid version to compare with.",
    }


async def test_diff_against_another_target_or_unknown_bundle_is_refused(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    first = await upload_ok(client, member_headers, build_fixture("gracie_like", token))
    other = await client.post(
        TARGETS_PATH, json={"name": "Other", "app_kind": "api"}, headers=member_headers
    )
    other_token = other.json()["target_token"]
    foreign = await upload_ok(client, member_headers, build_fixture("minimal_valid", other_token))
    crossed = await client.get(
        bundle_path(first["id"], "diff"), params={"against": foreign["id"]}, headers=member_headers
    )
    assert crossed.status_code == 422
    assert crossed.json()["error"]["details"][0]["code"] == "bundle_not_comparable"
    unknown = await client.get(
        bundle_path(first["id"], "diff"),
        params={"against": str(uuid.uuid4())},
        headers=member_headers,
    )
    assert unknown.status_code == 404
    bad = await client.get(
        bundle_path(first["id"], "diff"), params={"against": "nope"}, headers=member_headers
    )
    assert bad.status_code == 422


async def test_read_endpoints_need_a_login_but_not_the_member_role(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    token: str,
) -> None:
    uploaded = await upload_ok(client, member_headers, build_fixture("minimal_valid", token))
    for path in (
        bundle_path(uploaded["id"]),
        bundle_path(uploaded["id"], "diff"),
        bundle_path(uploaded["id"], "files"),
    ):
        assert (await client.get(path, headers=viewer_headers)).status_code == 200
        assert (await client.get(path)).status_code == 401
    assert (
        await client.get(BUNDLES_PATH + "/not-a-uuid", headers=viewer_headers)
    ).status_code == 422


async def test_changed_manifest_text_alone_gives_a_new_version_with_no_feature_changes(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    first = await upload_ok(client, member_headers, build_fixture("gracie_like", token))
    files = dict(gracie_like_changed(token))
    files["README.md"] = b"# Edited readme\n"
    changed = await upload_ok(client, member_headers, build_zip(files, prefix="tessa/"))
    assert changed["version"] == 2
    assert changed["diff_summary"]["against_bundle_id"] == first["id"]
    diff = await client.get(bundle_path(changed["id"], "diff"), headers=member_headers)
    sections = {item["section"]: item["change"] for item in diff.json()["sections"]}
    assert sections["files:README.md"] == "changed"
    assert sections["features"] == "changed"
