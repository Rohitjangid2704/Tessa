import re
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from tessa_api.schemas.enums import UserRole
from tessa_api.services.target_token import find_target_by_token
from tests.stage_one import TARGETS_PATH, create_target, insert_bundle, sample_manifest
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration

TOKEN_PATTERN = re.compile(r"^tgt_[a-z2-7]{22}$")


@pytest.fixture
async def member_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.member))


@pytest.fixture
async def admin_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.admin))


@pytest.fixture
async def viewer_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.viewer))


async def test_member_creates_a_target_with_slug_and_token(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers, name="Gracie QA")
    assert created["slug"] == "gracie-qa"
    assert created["name"] == "Gracie QA"
    assert created["app_kind"] == "llm_assistant"
    assert created["tier"] == "qa"
    assert created["allow_production"] is False
    assert TOKEN_PATTERN.match(created["target_token"])
    assert created["hints"] == {}
    assert created["latest_bundle_id"] is None
    assert created["archived_at"] is None
    assert created["created_at"].endswith("Z")


async def test_slugs_stay_unique_for_equal_and_messy_names(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    slugs = [
        (await create_target(client, member_headers, name=name))["slug"]
        for name in ("Gracie", "Gracie", "  gracie!!  ", "Gracie", "Ünïcode Näme", "###")
    ]
    assert slugs == ["gracie", "gracie-2", "gracie-3", "gracie-4", "unicode-name", "target"]


async def test_names_must_not_be_blank(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await client.post(
        TARGETS_PATH, json={"name": "   ", "app_kind": "api"}, headers=member_headers
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["body", "name"]


async def test_unknown_app_kind_is_rejected(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await client.post(
        TARGETS_PATH, json={"name": "X", "app_kind": "mainframe"}, headers=member_headers
    )
    assert response.status_code == 422


async def test_viewer_cannot_create_and_anonymous_is_unauthenticated(
    client: httpx.AsyncClient, viewer_headers: dict[str, str]
) -> None:
    forbidden = await client.post(
        TARGETS_PATH, json={"name": "X", "app_kind": "api"}, headers=viewer_headers
    )
    anonymous = await client.get(TARGETS_PATH)
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "role_required"
    assert anonymous.status_code == 401


async def test_only_an_admin_creates_a_production_target(
    client: httpx.AsyncClient, member_headers: dict[str, str], admin_headers: dict[str, str]
) -> None:
    denied = await client.post(
        TARGETS_PATH,
        json={"name": "Live", "app_kind": "web", "tier": "production"},
        headers=member_headers,
    )
    allowed = await client.post(
        TARGETS_PATH,
        json={"name": "Live", "app_kind": "web", "tier": "production"},
        headers=admin_headers,
    )
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "role_required"
    assert allowed.status_code == 201
    assert allowed.json()["tier"] == "production"
    assert allowed.json()["allow_production"] is False


async def test_viewer_reads_a_target(
    client: httpx.AsyncClient, member_headers: dict[str, str], viewer_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers)
    response = await client.get(f"{TARGETS_PATH}/{created['id']}", headers=viewer_headers)
    assert response.status_code == 200
    assert response.json() == created


async def test_unknown_target_is_404(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await client.get(
        f"{TARGETS_PATH}/0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11", headers=member_headers
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_member_edits_name_kind_and_hints_but_the_slug_stays(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers, name="Old name")
    response = await client.patch(
        f"{TARGETS_PATH}/{created['id']}",
        json={"name": "New name", "app_kind": "api", "hints": {"hint_ids": ["list_tools"]}},
        headers=member_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "New name"
    assert body["slug"] == "old-name"
    assert body["app_kind"] == "api"
    assert body["hints"] == {"hint_ids": ["list_tools"]}
    assert body["target_token"] == created["target_token"]


async def test_patch_with_an_empty_body_changes_nothing(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers)
    response = await client.patch(
        f"{TARGETS_PATH}/{created['id']}", json={}, headers=member_headers
    )
    assert response.status_code == 200
    assert response.json() == created


@pytest.mark.parametrize("field", ["name", "app_kind", "tier", "allow_production", "hints"])
async def test_required_fields_cannot_be_set_to_null(
    client: httpx.AsyncClient, member_headers: dict[str, str], field: str
) -> None:
    created = await create_target(client, member_headers)
    response = await client.patch(
        f"{TARGETS_PATH}/{created['id']}", json={field: None}, headers=member_headers
    )
    assert response.status_code == 422
    detail = response.json()["error"]["details"][0]
    assert detail["loc"] == ["body", field]
    assert detail["code"] == "null_not_allowed"


async def test_production_fields_are_admin_only(
    client: httpx.AsyncClient, member_headers: dict[str, str], admin_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers)
    path = f"{TARGETS_PATH}/{created['id']}"
    for body in ({"allow_production": True}, {"tier": "production"}):
        denied = await client.patch(path, json=body, headers=member_headers)
        assert denied.status_code == 403
        assert denied.json()["error"]["code"] == "role_required"
    unchanged = await client.get(path, headers=member_headers)
    assert unchanged.json()["tier"] == "qa"
    assert unchanged.json()["allow_production"] is False

    promoted = await client.patch(
        path, json={"tier": "production", "allow_production": True}, headers=admin_headers
    )
    assert promoted.status_code == 200
    assert promoted.json()["tier"] == "production"
    assert promoted.json()["allow_production"] is True


async def test_member_cannot_lower_the_tier_of_a_production_target(
    client: httpx.AsyncClient, member_headers: dict[str, str], admin_headers: dict[str, str]
) -> None:
    created = await create_target(client, admin_headers, name="Live", tier="production")
    path = f"{TARGETS_PATH}/{created['id']}"
    denied = await client.patch(path, json={"tier": "qa"}, headers=member_headers)
    assert denied.status_code == 403
    lowered = await client.patch(path, json={"tier": "qa"}, headers=admin_headers)
    assert lowered.status_code == 200
    assert lowered.json()["tier"] == "qa"


async def test_repeating_the_current_production_value_is_not_a_change(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers)
    response = await client.patch(
        f"{TARGETS_PATH}/{created['id']}",
        json={"tier": "qa", "allow_production": False, "name": "Renamed"},
        headers=member_headers,
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"


async def test_only_an_admin_archives_and_archived_targets_leave_the_default_list(
    client: httpx.AsyncClient, member_headers: dict[str, str], admin_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers, name="Doomed")
    await create_target(client, member_headers, name="Kept")
    path = f"{TARGETS_PATH}/{created['id']}"

    denied = await client.delete(path, headers=member_headers)
    assert denied.status_code == 403
    archived = await client.delete(path, headers=admin_headers)
    again = await client.delete(path, headers=admin_headers)
    assert archived.status_code == 204
    assert archived.content == b""
    assert again.status_code == 204

    listed = await client.get(TARGETS_PATH, headers=member_headers)
    with_archived = await client.get(
        TARGETS_PATH, params={"include_archived": "true"}, headers=member_headers
    )
    assert [item["name"] for item in listed.json()["items"]] == ["Kept"]
    assert {item["name"] for item in with_archived.json()["items"]} == {"Doomed", "Kept"}
    archived_item = next(i for i in with_archived.json()["items"] if i["name"] == "Doomed")
    assert archived_item["archived_at"] is not None
    detail = await client.get(path, headers=member_headers)
    assert detail.status_code == 200
    assert detail.json()["archived_at"] is not None


async def test_archived_targets_reject_edits_and_token_rotation(
    client: httpx.AsyncClient, member_headers: dict[str, str], admin_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers)
    path = f"{TARGETS_PATH}/{created['id']}"
    await client.delete(path, headers=admin_headers)
    edit = await client.patch(path, json={"name": "X"}, headers=member_headers)
    rotate = await client.post(f"{path}/token/rotate", headers=member_headers)
    assert edit.status_code == 409
    assert edit.json()["error"]["code"] == "conflict"
    assert rotate.status_code == 409


async def test_deleting_an_unknown_target_is_404(
    client: httpx.AsyncClient, admin_headers: dict[str, str]
) -> None:
    response = await client.delete(
        f"{TARGETS_PATH}/0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11", headers=admin_headers
    )
    assert response.status_code == 404


async def test_rotating_moves_the_old_token_to_previous_and_both_still_match(
    client: httpx.AsyncClient, db_app: FastAPI, member_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers)
    first_token = created["target_token"]
    response = await client.post(
        f"{TARGETS_PATH}/{created['id']}/token/rotate", headers=member_headers
    )
    assert response.status_code == 200
    second_token = response.json()["target_token"]
    assert second_token != first_token
    assert TOKEN_PATTERN.match(second_token)
    assert response.json()["id"] == created["id"]

    async with db_app.state.session_factory() as session:
        by_old = await find_target_by_token(session, first_token)
        by_new = await find_target_by_token(session, second_token)
        unknown = await find_target_by_token(session, "tgt_aaaaaaaaaaaaaaaaaaaaaa")
    assert by_old is not None
    assert by_old.matched_previous is True
    assert str(by_old.target.id) == created["id"]
    assert by_old.target.previous_target_token == first_token
    assert by_new is not None
    assert by_new.matched_previous is False
    assert unknown is None


async def test_a_second_rotation_forgets_the_oldest_token(
    client: httpx.AsyncClient, db_app: FastAPI, member_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers)
    path = f"{TARGETS_PATH}/{created['id']}/token/rotate"
    second = (await client.post(path, headers=member_headers)).json()["target_token"]
    third = (await client.post(path, headers=member_headers)).json()["target_token"]
    async with db_app.state.session_factory() as session:
        oldest = await find_target_by_token(session, created["target_token"])
        previous = await find_target_by_token(session, second)
        current = await find_target_by_token(session, third)
    assert oldest is None
    assert previous is not None
    assert previous.matched_previous is True
    assert current is not None


async def test_viewer_cannot_rotate(
    client: httpx.AsyncClient, member_headers: dict[str, str], viewer_headers: dict[str, str]
) -> None:
    created = await create_target(client, member_headers)
    response = await client.post(
        f"{TARGETS_PATH}/{created['id']}/token/rotate", headers=viewer_headers
    )
    assert response.status_code == 403


async def test_list_filters_by_text_kind_and_tier(
    client: httpx.AsyncClient, member_headers: dict[str, str], admin_headers: dict[str, str]
) -> None:
    await create_target(client, member_headers, name="Gracie", app_kind="llm_assistant")
    await create_target(client, member_headers, name="Billing API", app_kind="api")
    await create_target(client, member_headers, name="Billing Web", app_kind="web")
    await create_target(client, admin_headers, name="Live Shop", app_kind="web", tier="production")

    def names(response: httpx.Response) -> list[str]:
        assert response.status_code == 200, response.text
        return sorted(item["name"] for item in response.json()["items"])

    by_text = await client.get(TARGETS_PATH, params={"q": "bill"}, headers=member_headers)
    by_slug = await client.get(TARGETS_PATH, params={"q": "live-sh"}, headers=member_headers)
    by_kinds = await client.get(
        TARGETS_PATH,
        params=[("app_kind", "api"), ("app_kind", "llm_assistant")],
        headers=member_headers,
    )
    by_tier = await client.get(TARGETS_PATH, params={"tier": "production"}, headers=member_headers)
    by_wildcard = await client.get(TARGETS_PATH, params={"q": "%"}, headers=member_headers)
    assert names(by_text) == ["Billing API", "Billing Web"]
    assert names(by_slug) == ["Live Shop"]
    assert names(by_kinds) == ["Billing API", "Gracie"]
    assert names(by_tier) == ["Live Shop"]
    assert names(by_wildcard) == []


async def test_list_sorts_by_name_ascending(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    for name in ("Charlie", "Alpha", "Bravo"):
        await create_target(client, member_headers, name=name)
    response = await client.get(TARGETS_PATH, params={"sort": "name"}, headers=member_headers)
    assert [item["name"] for item in response.json()["items"]] == ["Alpha", "Bravo", "Charlie"]


async def test_summary_reports_the_latest_bundle_and_unchecked_health(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    make_user: MakeUser,
    member_headers: dict[str, str],
) -> None:
    uploader = await make_user(UserRole.member)
    bare = await create_target(client, member_headers, name="Bare")
    versioned = await create_target(client, member_headers, name="Versioned")
    await insert_bundle(
        db_app, versioned["id"], uploader.id, sample_manifest(), version=1, score=60
    )
    await insert_bundle(
        db_app, versioned["id"], uploader.id, None, version=2, valid=False, score=10
    )
    response = await client.get(TARGETS_PATH, headers=member_headers)
    by_name = {item["name"]: item for item in response.json()["items"]}
    assert by_name["Bare"]["latest_bundle_version"] is None
    assert by_name["Bare"]["completeness_score"] is None
    assert by_name["Bare"]["health"] == "unchecked"
    assert by_name["Versioned"]["latest_bundle_version"] == 2
    assert by_name["Versioned"]["completeness_score"] == 10
    assert set(by_name["Versioned"]) == {
        "id",
        "name",
        "slug",
        "app_kind",
        "tier",
        "latest_bundle_version",
        "completeness_score",
        "health",
        "created_at",
        "archived_at",
    }
    detail = await client.get(f"{TARGETS_PATH}/{versioned['id']}", headers=member_headers)
    assert detail.json()["latest_bundle_id"] is not None
    bare_detail = await client.get(f"{TARGETS_PATH}/{bare['id']}", headers=member_headers)
    assert bare_detail.json()["latest_bundle_id"] is None
