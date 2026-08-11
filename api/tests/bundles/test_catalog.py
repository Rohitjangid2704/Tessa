import uuid
from typing import Any

import httpx
import pytest

from tests.bundle_fixtures import build_fixture
from tests.bundles.support import CATALOG_PATH, upload_zip
from tests.stage_one import TARGETS_PATH, environment_path

pytestmark = pytest.mark.integration


async def load_gracie(
    client: httpx.AsyncClient, headers: dict[str, str], token: str, name: str = "gracie_like"
) -> dict[str, Any]:
    response = await upload_zip(client, headers, build_fixture(name, token))
    assert response.status_code == 201, response.text
    bundle: dict[str, Any] = response.json()["bundle"]
    return bundle


async def read_catalog(
    client: httpx.AsyncClient, headers: dict[str, str], target_id: str, **params: Any
) -> dict[str, Any]:
    response = await client.get(
        CATALOG_PATH, params={"target_id": target_id, **params}, headers=headers
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def feature_ids(catalog: dict[str, Any]) -> list[str]:
    return [item["feature_id"] for area in catalog["areas"] for item in area["items"]]


async def test_catalog_groups_features_by_area_with_roles_and_interfaces(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    bundle = await load_gracie(client, member_headers, token)
    catalog = await read_catalog(client, viewer_headers, target["id"])
    assert catalog["bundle_id"] == bundle["id"]
    assert catalog["bundle_version"] == 1
    assert [role["id"] for role in catalog["roles"]] == ["staff", "manager", "admin"]
    assert catalog["roles"][1] == {
        "id": "manager",
        "level": 2,
        "description": "Property manager",
    }
    assert catalog["interfaces"] == [
        {"id": "chat_sse", "kind": "sse", "base_path": "/api/chat"},
        {"id": "browser", "kind": "browser", "base_path": "/"},
        {"id": "admin_api", "kind": "http", "base_path": "/api/admin"},
    ]
    assert [area["name"] for area in catalog["areas"]] == ["Admin", "Auth", "Smart Log"]
    smart_log = next(area for area in catalog["areas"] if area["name"] == "Smart Log")
    assert [item["feature_id"] for item in smart_log["items"]] == [
        "smart_log.read.open_maintenance",
        "smart_log.write.create_issue",
    ]
    read = smart_log["items"][0]
    assert read["bundle_id"] == bundle["id"]
    assert read["kind"] == "read"
    assert read["interface_ids"] == ["chat_sse", "browser"]
    assert read["roles"] == ["all"]
    assert read["flag"] == "none"
    assert read["preconditions"] == ["seed.smart_log_history"]
    assert read["invariants"] == ["no_internal_ids", "count_matches_oracle", "empty_set_honesty"]
    assert read["cleanup"] == "none"
    assert read["confidence"] == "high"
    assert read["examples"][0] == {
        "ask": "Which maintenance issues are still open?",
        "request": None,
        "expected": "count of open items and the rooms with the most, from the oracle",
        "oracle": "open_maintenance",
    }
    assert read["writes_to"] is None
    assert read["confirmation"] is None
    assert read["expect_db"] is None
    write = smart_log["items"][1]
    assert write["kind"] == "write"
    assert write["writes_to"] == "smart_log_issue"
    assert write["confirmation"] == "button-only, typed yes accepted"
    assert write["expect_db"] == {
        "table": "smart_log_issue",
        "where": {"room_number": "20003", "status": "open"},
    }
    assert write["flag"] == "confirmation_gate"
    assert write["cleanup"] == "delete the issue created by the run"


async def test_catalog_filters(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    await load_gracie(client, member_headers, token)
    tid = target["id"]
    by_area = await read_catalog(client, member_headers, tid, area="Auth")
    assert feature_ids(by_area) == ["auth.login.staff"]
    two_areas = await read_catalog(client, member_headers, tid, area=["Auth", "Admin"])
    assert sorted(feature_ids(two_areas)) == ["admin.users.list", "auth.login.staff"]
    by_kind = await read_catalog(client, member_headers, tid, kind="write")
    assert feature_ids(by_kind) == ["smart_log.write.create_issue"]
    kinds = await read_catalog(client, member_headers, tid, kind=["write", "admin"])
    assert sorted(feature_ids(kinds)) == ["admin.users.list", "smart_log.write.create_issue"]
    staff = await read_catalog(client, member_headers, tid, role="staff")
    assert sorted(feature_ids(staff)) == [
        "auth.login.staff",
        "smart_log.read.open_maintenance",
        "smart_log.write.create_issue",
    ]
    admin = await read_catalog(client, member_headers, tid, role="admin")
    assert sorted(feature_ids(admin)) == ["admin.users.list", "smart_log.read.open_maintenance"]
    nobody = await read_catalog(client, member_headers, tid, role="janitor")
    assert feature_ids(nobody) == ["smart_log.read.open_maintenance"]
    both_roles = await read_catalog(client, member_headers, tid, role=["staff", "admin"])
    assert len(feature_ids(both_roles)) == 4
    by_interface = await read_catalog(client, member_headers, tid, interface_id="admin_api")
    assert feature_ids(by_interface) == ["admin.users.list"]
    by_confidence = await read_catalog(client, member_headers, tid, confidence="medium")
    assert sorted(feature_ids(by_confidence)) == [
        "admin.users.list",
        "smart_log.write.create_issue",
    ]
    combined = await read_catalog(client, member_headers, tid, role="staff", kind="read")
    assert feature_ids(combined) == ["smart_log.read.open_maintenance"]
    search = await read_catalog(client, member_headers, tid, q="MAINTENANCE")
    assert sorted(feature_ids(search)) == [
        "smart_log.read.open_maintenance",
        "smart_log.write.create_issue",
    ]
    by_id_text = await read_catalog(client, member_headers, tid, q="users.list")
    assert feature_ids(by_id_text) == ["admin.users.list"]
    by_area_text = await read_catalog(client, member_headers, tid, q="smart log")
    assert len(feature_ids(by_area_text)) == 2
    wildcard = await read_catalog(client, member_headers, tid, q="%")
    assert feature_ids(wildcard) == []
    underscore = await read_catalog(client, member_headers, tid, q="_")
    assert sorted(feature_ids(underscore)) == [
        "smart_log.read.open_maintenance",
        "smart_log.write.create_issue",
    ]


async def test_filters_that_match_nothing_keep_the_bundle_ids_and_the_full_roles_and_interfaces(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    bundle = await load_gracie(client, member_headers, token)
    catalog = await read_catalog(client, member_headers, target["id"], q="zzz")
    assert catalog["bundle_id"] == bundle["id"]
    assert catalog["areas"] == []
    assert len(catalog["roles"]) == 3
    assert len(catalog["interfaces"]) == 3


async def test_catalog_follows_the_latest_valid_bundle_and_an_explicit_bundle_id(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    first = await load_gracie(client, member_headers, token)
    second = await load_gracie(client, member_headers, token, "gracie_like_changed")
    await load_gracie(client, member_headers, token, "missing_sections")
    latest = await read_catalog(client, member_headers, target["id"])
    assert latest["bundle_id"] == second["id"]
    assert latest["bundle_version"] == 2
    assert "rooms.read.list" in feature_ids(latest)
    older = await read_catalog(client, member_headers, target["id"], bundle_id=first["id"])
    assert older["bundle_version"] == 1
    assert "rooms.read.list" not in feature_ids(older)


async def test_target_without_a_valid_bundle_gets_the_empty_shape(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    empty: dict[str, Any] = {
        "bundle_id": None,
        "bundle_version": None,
        "roles": [],
        "interfaces": [],
        "areas": [],
    }
    assert await read_catalog(client, member_headers, target["id"]) == empty
    invalid = await load_gracie(client, member_headers, token, "missing_sections")
    assert await read_catalog(client, member_headers, target["id"]) == empty
    explicit = await read_catalog(client, member_headers, target["id"], bundle_id=invalid["id"])
    assert explicit == {
        "bundle_id": invalid["id"],
        "bundle_version": 1,
        "roles": [],
        "interfaces": [],
        "areas": [],
    }


async def test_catalog_errors(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    gracie = await load_gracie(client, member_headers, token)
    unknown_target = await client.get(
        CATALOG_PATH, params={"target_id": str(uuid.uuid4())}, headers=viewer_headers
    )
    assert unknown_target.status_code == 404
    missing_target = await client.get(CATALOG_PATH, headers=viewer_headers)
    assert missing_target.status_code == 422
    unknown_param = await client.get(
        CATALOG_PATH, params={"target_id": target["id"], "color": "red"}, headers=viewer_headers
    )
    assert unknown_param.status_code == 422
    assert unknown_param.json()["error"]["details"][0]["loc"] == ["query", "color"]
    bad_kind = await client.get(
        CATALOG_PATH, params={"target_id": target["id"], "kind": "sideways"}, headers=viewer_headers
    )
    assert bad_kind.status_code == 422
    anonymous = await client.get(CATALOG_PATH, params={"target_id": target["id"]})
    assert anonymous.status_code == 401
    other = await client.post(
        TARGETS_PATH, json={"name": "Other", "app_kind": "api"}, headers=member_headers
    )
    foreign_bundle = await client.get(
        CATALOG_PATH,
        params={"target_id": other.json()["id"], "bundle_id": gracie["id"]},
        headers=viewer_headers,
    )
    assert foreign_bundle.status_code == 404
    unknown_bundle = await client.get(
        CATALOG_PATH,
        params={"target_id": target["id"], "bundle_id": str(uuid.uuid4())},
        headers=viewer_headers,
    )
    assert unknown_bundle.status_code == 404


async def test_catalog_item_detail(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    await load_gracie(client, member_headers, token)
    catalog = await read_catalog(client, viewer_headers, target["id"])
    item = catalog["areas"][-1]["items"][1]
    detail = await client.get(f"{CATALOG_PATH}/items/{item['id']}", headers=viewer_headers)
    assert detail.status_code == 200
    assert detail.json() == item
    missing = await client.get(f"{CATALOG_PATH}/items/{uuid.uuid4()}", headers=viewer_headers)
    assert missing.status_code == 404
    anonymous = await client.get(f"{CATALOG_PATH}/items/{item['id']}")
    assert anonymous.status_code == 401


async def test_environment_is_reconciled_from_the_manifest_and_template(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    await load_gracie(client, member_headers, token)
    response = await client.get(environment_path(target["id"]), headers=member_headers)
    body = response.json()
    variables = {item["name"]: item for item in body["items"]}
    assert set(variables) == {
        "GRACIE_BASE_URL",
        "STAFF_EMAIL",
        "STAFF_PASSWORD",
        "MANAGER_TOKEN",
        "ADMIN_TOKEN",
        "SMART_LOG_TENANT_ID",
        "TRUTH_DB_DSN",
        "SEED_DB_DSN",
    }
    base = variables["GRACIE_BASE_URL"]
    assert base["kind"] == "url"
    assert base["secret"] is False
    assert base["required"] is True
    assert base["interface_ids"] == ["chat_sse", "browser", "admin_api"]
    assert base["purpose"] == "Base URL of the QA deployment"
    assert base["has_value"] is False
    assert base["stale"] is False
    assert variables["TRUTH_DB_DSN"]["kind"] == "dsn"
    assert variables["TRUTH_DB_DSN"]["secret"] is True
    assert variables["STAFF_PASSWORD"]["kind"] == "password"
    assert variables["SEED_DB_DSN"]["required"] is False
    assert body["missing_required"] == 7


async def test_a_new_version_marks_removed_variables_stale_and_keeps_entered_values(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    await load_gracie(client, member_headers, token)
    patch = await client.patch(
        environment_path(target["id"]),
        json={"set": {"GRACIE_BASE_URL": "http://localhost:9999"}, "clear": []},
        headers=member_headers,
    )
    assert patch.status_code == 200
    await load_gracie(client, member_headers, token, "minimal_valid")
    after = await client.get(environment_path(target["id"]), headers=member_headers)
    variables = {item["name"]: item for item in after.json()["items"]}
    assert variables["GRACIE_BASE_URL"]["stale"] is True
    assert variables["GRACIE_BASE_URL"]["has_value"] is True
    assert variables["GRACIE_BASE_URL"]["value"] == "http://localhost:9999"
    assert variables["NOTES_BASE_URL"]["stale"] is False
    assert variables["NOTES_BASE_URL"]["has_value"] is False
    assert variables["TRUTH_DB_DSN"]["stale"] is True
    again = await load_gracie(client, member_headers, token, "gracie_like_changed")
    assert again["version"] == 3
    final = await client.get(environment_path(target["id"]), headers=member_headers)
    restored = {item["name"]: item for item in final.json()["items"]}
    assert restored["GRACIE_BASE_URL"]["stale"] is False
    assert restored["GRACIE_BASE_URL"]["has_value"] is True
    assert restored["NOTES_BASE_URL"]["stale"] is True


async def test_an_invalid_bundle_does_not_touch_the_environment(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    token: str,
) -> None:
    await load_gracie(client, member_headers, token)
    await load_gracie(client, member_headers, token, "missing_sections")
    after = await client.get(environment_path(target["id"]), headers=member_headers)
    assert len(after.json()["items"]) == 8
    assert not any(item["stale"] for item in after.json()["items"])
