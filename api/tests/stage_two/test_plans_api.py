from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import update

from tessa_api.db.models import CoverageCellRow
from tessa_api.schemas.enums import CellStatus, UserRole
from tests.stage_one import create_target
from tests.stage_two.support import (
    CREATE_ISSUE,
    LIST_USERS,
    LOGIN_STAFF,
    OPEN_ISSUES,
    PLANS_PATH,
    clear_environment,
    plan_body,
    seed_gracie,
    set_environment,
)
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration

PREVIEW_PATH = f"{PLANS_PATH}/preview"


def error_of(response: httpx.Response) -> dict[str, Any]:
    error: dict[str, Any] = response.json()["error"]
    return error


async def test_preview_expands_features_roles_and_interfaces_into_cells(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    response = await client.post(
        PREVIEW_PATH,
        json=plan_body(seeded.target_id, interface_mode="both"),
        headers=member_headers,
    )
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["cells_total"] == 6
    assert preview["scenarios_estimated"] == 6
    assert preview["effective_budget"] == {"max_usd": 5.0, "max_minutes": 30}
    assert preview["estimated_cost_usd"] == pytest.approx(6 * 0.10)
    assert preview["skipped"] == []
    assert any("no bundle example or flow" in warning for warning in preview["warnings"])


async def test_api_only_leaves_out_every_browser_cell(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    response = await client.post(
        PREVIEW_PATH,
        json=plan_body(seeded.target_id, feature_ids=[OPEN_ISSUES, CREATE_ISSUE]),
        headers=member_headers,
    )
    assert response.json()["cells_total"] == 5
    browser_only = await client.post(
        PREVIEW_PATH,
        json=plan_body(
            seeded.target_id, feature_ids=[OPEN_ISSUES, CREATE_ISSUE], interface_mode="browser_only"
        ),
        headers=member_headers,
    )
    assert browser_only.json()["cells_total"] == 5
    assert browser_only.json()["scenarios_estimated"] == 1


async def test_a_selection_by_area_covers_every_feature_of_the_area(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    response = await client.post(
        PREVIEW_PATH,
        json=plan_body(seeded.target_id, feature_ids=[], area_ids=["Smart Log"]),
        headers=member_headers,
    )
    assert response.json()["cells_total"] == 5


async def test_the_budget_of_the_selection_is_echoed_and_defaults_apply_when_absent(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    given = await client.post(
        PREVIEW_PATH,
        json=plan_body(seeded.target_id, budget={"max_usd": 1.5, "max_minutes": 7}),
        headers=member_headers,
    )
    assert given.json()["effective_budget"] == {"max_usd": 1.5, "max_minutes": 7}


async def test_unknown_ids_are_ignored_with_a_warning(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    response = await client.post(
        PREVIEW_PATH,
        json=plan_body(
            seeded.target_id,
            feature_ids=[OPEN_ISSUES, "nope.read.missing"],
            area_ids=["Nowhere"],
            roles=["staff", "ghost"],
        ),
        headers=member_headers,
    )
    assert response.status_code == 200
    preview = response.json()
    assert preview["cells_total"] == 1
    joined = " ".join(preview["warnings"])
    assert "nope.read.missing" in joined
    assert "Nowhere" in joined
    assert "ghost" in joined


async def test_missing_environment_values_skip_cells_with_their_reason(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    await clear_environment(client, member_headers, seeded.target_id, ["MANAGER_TOKEN"])
    preview = (
        await client.post(PREVIEW_PATH, json=plan_body(seeded.target_id), headers=member_headers)
    ).json()
    assert preview["cells_total"] == 3
    assert preview["skipped"] == [
        {
            "feature_id": OPEN_ISSUES,
            "role": "manager",
            "interface_id": "chat_sse",
            "reason": "role_unavailable",
        }
    ]
    assert preview["scenarios_estimated"] == 4
    await clear_environment(client, member_headers, seeded.target_id, ["GRACIE_BASE_URL"])
    without_url = (
        await client.post(PREVIEW_PATH, json=plan_body(seeded.target_id), headers=member_headers)
    ).json()
    reasons = {item["reason"] for item in without_url["skipped"]}
    assert reasons == {"env_missing"}
    assert without_url["scenarios_estimated"] == 0


async def test_every_depth_is_accepted_and_an_unknown_one_is_refused(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    for depth in ("smoke", "standard", "deep"):
        response = await client.post(
            PREVIEW_PATH, json=plan_body(seeded.target_id, depth=depth), headers=member_headers
        )
        assert response.status_code == 200, (depth, response.text)
        saved = await client.post(
            PLANS_PATH,
            json=plan_body(seeded.target_id, depth=depth, name=f"Depth {depth}"),
            headers=member_headers,
        )
        assert saved.status_code == 201, (depth, saved.text)
        assert saved.json()["selection"]["depth"] == depth
    unknown = await client.post(
        PREVIEW_PATH, json=plan_body(seeded.target_id, depth="extreme"), headers=member_headers
    )
    assert unknown.status_code == 422
    assert unknown.json()["error"]["details"][0]["loc"] == ["body", "selection", "depth"]


async def test_k_is_capped_by_the_server_setting(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    db_app.state.settings = db_app.state.settings.model_copy(update={"plan_max_k": 3})
    response = await client.post(
        PREVIEW_PATH, json=plan_body(seeded.target_id, k=4), headers=member_headers
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["body", "selection", "k"]
    accepted = await client.post(
        PREVIEW_PATH, json=plan_body(seeded.target_id, k=3), headers=member_headers
    )
    assert accepted.status_code == 200


async def test_saving_an_empty_selection_is_plan_empty_but_a_preview_just_warns(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    body = plan_body(seeded.target_id, feature_ids=[], area_ids=[])
    saved = await client.post(PLANS_PATH, json=body, headers=member_headers)
    assert saved.status_code == 422
    assert error_of(saved)["code"] == "plan_empty"
    assert error_of(saved)["details"][0]["loc"] == ["body", "selection"]
    preview = await client.post(PREVIEW_PATH, json=body, headers=member_headers)
    assert preview.status_code == 200
    assert preview.json()["cells_total"] == 0
    assert any("no cells" in warning for warning in preview.json()["warnings"])


async def test_a_target_without_a_valid_bundle_is_not_ready(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    target = await create_target(client, member_headers, name="Empty")
    response = await client.post(
        PREVIEW_PATH, json=plan_body(str(target["id"])), headers=member_headers
    )
    assert response.status_code == 409
    assert error_of(response)["code"] == "target_not_ready"
    assert error_of(response)["details"][0]["loc"] == ["bundle"]


async def test_an_unknown_target_is_not_found(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await client.post(
        PREVIEW_PATH,
        json=plan_body("0198f6f2-7b00-7a00-9d00-0000000000ff"),
        headers=member_headers,
    )
    assert response.status_code == 404


async def test_saving_a_plan_materialises_unique_cells_with_families(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    body = plan_body(
        seeded.target_id,
        name="Smart Log reads",
        feature_ids=[OPEN_ISSUES, CREATE_ISSUE, LOGIN_STAFF, LIST_USERS],
        interface_mode="both",
    )
    response = await client.post(PLANS_PATH, json=body, headers=member_headers)
    assert response.status_code == 201, response.text
    plan = response.json()
    assert plan["name"] == "Smart Log reads"
    assert plan["saved"] is True
    assert plan["bundle_id"] == seeded.bundle_id
    assert plan["is_coverage_baseline"] is False
    assert plan["schedule_id"] is None
    assert plan["effective_budget"] == {"max_usd": 5.0, "max_minutes": 30}
    assert plan["cells_total"] == 12
    cells = (await client.get(f"{PLANS_PATH}/{plan['id']}/cells", headers=member_headers)).json()
    keys = [(cell["feature_id"], cell["role"], cell["interface_id"]) for cell in cells["items"]]
    assert len(keys) == len(set(keys)) == 12
    assert {cell["family"] for cell in cells["items"]} == {"smart-log", "auth", "admin"}
    assert {cell["status"] for cell in cells["items"]} == {"empty"}
    assert keys == sorted(keys)


async def test_cells_filter_by_feature_and_status_and_page(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan = (
        await client.post(
            PLANS_PATH,
            json=plan_body(seeded.target_id, feature_ids=[OPEN_ISSUES, CREATE_ISSUE]),
            headers=member_headers,
        )
    ).json()
    path = f"{PLANS_PATH}/{plan['id']}/cells"
    only = await client.get(path, params={"feature_id": CREATE_ISSUE}, headers=member_headers)
    assert [cell["role"] for cell in only.json()["items"]] == ["manager", "staff"]
    none = await client.get(path, params={"status": "covered"}, headers=member_headers)
    assert none.json()["items"] == []
    first = await client.get(
        path, params={"limit": 2, "include_total": "true"}, headers=member_headers
    )
    assert first.json()["total"] == 5
    assert len(first.json()["items"]) == 2
    second = await client.get(
        path, params={"limit": 2, "cursor": first.json()["next_cursor"]}, headers=member_headers
    )
    assert len(second.json()["items"]) == 2
    bad_sort = await client.get(path, params={"sort": "nope"}, headers=member_headers)
    assert bad_sort.status_code == 422


async def test_plans_list_filters_by_target_and_saved_flag(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    other = await seed_gracie(client, member_headers, name="Other")
    kept = (
        await client.post(PLANS_PATH, json=plan_body(seeded.target_id), headers=member_headers)
    ).json()
    scratch = (
        await client.post(
            PLANS_PATH, json=plan_body(seeded.target_id, saved=False), headers=member_headers
        )
    ).json()
    elsewhere = (
        await client.post(PLANS_PATH, json=plan_body(other.target_id), headers=member_headers)
    ).json()
    everything = await client.get(PLANS_PATH, headers=member_headers)
    assert {item["id"] for item in everything.json()["items"]} == {
        kept["id"],
        scratch["id"],
        elsewhere["id"],
    }
    saved = await client.get(
        PLANS_PATH, params={"target_id": seeded.target_id, "saved": "true"}, headers=member_headers
    )
    assert [item["id"] for item in saved.json()["items"]] == [kept["id"]]
    unsaved = await client.get(PLANS_PATH, params={"saved": "false"}, headers=member_headers)
    assert [item["id"] for item in unsaved.json()["items"]] == [scratch["id"]]
    newest_first = [item["id"] for item in everything.json()["items"]]
    assert newest_first == [elsewhere["id"], scratch["id"], kept["id"]]


async def test_a_plan_is_read_renamed_reselected_and_deleted(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan = (
        await client.post(
            PLANS_PATH, json=plan_body(seeded.target_id, name="First"), headers=member_headers
        )
    ).json()
    path = f"{PLANS_PATH}/{plan['id']}"
    assert (await client.get(path, headers=member_headers)).json() == plan
    renamed = await client.patch(path, json={"name": "Second"}, headers=member_headers)
    assert renamed.json()["name"] == "Second"
    assert renamed.json()["cells_total"] == plan["cells_total"]
    cleared = await client.patch(path, json={"name": None}, headers=member_headers)
    assert cleared.json()["name"] is None
    untouched = await client.patch(path, json={}, headers=member_headers)
    assert untouched.json()["name"] is None
    reselected = await client.patch(
        path,
        json={"selection": plan_body(seeded.target_id, feature_ids=[LIST_USERS])["selection"]},
        headers=member_headers,
    )
    assert reselected.status_code == 200, reselected.text
    assert reselected.json()["cells_total"] == 1
    cells = (await client.get(f"{path}/cells", headers=member_headers)).json()["items"]
    assert [(cell["feature_id"], cell["role"]) for cell in cells] == [(LIST_USERS, "admin")]
    empty = await client.patch(
        path,
        json={"selection": plan_body(seeded.target_id, feature_ids=[])["selection"]},
        headers=member_headers,
    )
    assert empty.status_code == 422
    assert error_of(empty)["code"] == "plan_empty"
    deleted = await client.delete(path, headers=member_headers)
    assert deleted.status_code == 204
    assert deleted.content == b""
    assert (await client.get(path, headers=member_headers)).status_code == 404
    assert (await client.delete(path, headers=member_headers)).status_code == 404


async def test_reselecting_keeps_the_status_of_cells_that_stay(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan = (
        await client.post(
            PLANS_PATH,
            json=plan_body(seeded.target_id, feature_ids=[LIST_USERS, CREATE_ISSUE]),
            headers=member_headers,
        )
    ).json()
    async with db_app.state.session_factory() as session:
        await session.execute(
            update(CoverageCellRow)
            .where(CoverageCellRow.feature_id == LIST_USERS)
            .values(status=CellStatus.generated)
        )
        await session.commit()
    await client.patch(
        f"{PLANS_PATH}/{plan['id']}",
        json={"selection": plan_body(seeded.target_id, feature_ids=[LIST_USERS])["selection"]},
        headers=member_headers,
    )
    cells = (await client.get(f"{PLANS_PATH}/{plan['id']}/cells", headers=member_headers)).json()[
        "items"
    ]
    assert [(cell["feature_id"], cell["status"]) for cell in cells] == [(LIST_USERS, "generated")]


async def test_a_viewer_reads_but_cannot_write_plans(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
) -> None:
    seeded = await seed_gracie(client, member_headers)
    body = plan_body(seeded.target_id)
    plan = (await client.post(PLANS_PATH, json=body, headers=member_headers)).json()
    assert (await client.post(PREVIEW_PATH, json=body, headers=viewer_headers)).status_code == 200
    assert (await client.get(PLANS_PATH, headers=viewer_headers)).status_code == 200
    assert (
        await client.get(f"{PLANS_PATH}/{plan['id']}", headers=viewer_headers)
    ).status_code == 200
    assert (await client.post(PLANS_PATH, json=body, headers=viewer_headers)).status_code == 403
    assert (
        await client.patch(f"{PLANS_PATH}/{plan['id']}", json={}, headers=viewer_headers)
    ).status_code == 403
    assert (
        await client.delete(f"{PLANS_PATH}/{plan['id']}", headers=viewer_headers)
    ).status_code == 403


async def test_saving_a_plan_with_an_idempotency_key_replays_the_answer(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    headers = {**member_headers, "Idempotency-Key": "plan-key-0001"}
    first = await client.post(PLANS_PATH, json=plan_body(seeded.target_id), headers=headers)
    second = await client.post(PLANS_PATH, json=plan_body(seeded.target_id), headers=headers)
    assert first.status_code == second.status_code == 201
    assert second.headers["Idempotency-Replayed"] == "true"
    assert second.json() == first.json()
    different = await client.post(
        PLANS_PATH, json=plan_body(seeded.target_id, k=2), headers=headers
    )
    assert different.status_code == 409
    assert error_of(different)["code"] == "idempotency_conflict"


async def test_an_archived_target_cannot_get_new_plans(
    client: httpx.AsyncClient, member_headers: dict[str, str], admin_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers)
    archived = await client.delete(f"/api/v1/targets/{seeded.target_id}", headers=admin_headers)
    assert archived.status_code in (200, 204)
    response = await client.post(
        PLANS_PATH, json=plan_body(seeded.target_id), headers=member_headers
    )
    assert response.status_code == 409


async def test_unauthenticated_calls_are_refused(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    assert (await client.get(PLANS_PATH)).status_code == 401
    assert (await client.post(PREVIEW_PATH, json={})).status_code == 401


async def test_roles_of_a_member_and_an_admin_are_both_accepted(
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    member_headers: dict[str, str],
) -> None:
    seeded = await seed_gracie(client, member_headers)
    admin = auth_headers(await make_user(UserRole.admin))
    response = await client.post(PLANS_PATH, json=plan_body(seeded.target_id), headers=admin)
    assert response.status_code == 201
    assert response.json()["created_by"]


async def test_environment_changes_move_the_preview_without_touching_stored_cells(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    seeded = await seed_gracie(client, member_headers, values={})
    preview = (
        await client.post(PREVIEW_PATH, json=plan_body(seeded.target_id), headers=member_headers)
    ).json()
    assert preview["cells_total"] == 3
    assert {item["reason"] for item in preview["skipped"]} == {"env_missing"}
    await set_environment(
        client,
        member_headers,
        seeded.target_id,
        {
            "GRACIE_BASE_URL": "http://localhost:8080",
            "STAFF_EMAIL": "staff@example.test",
            "STAFF_PASSWORD": "pw",
            "MANAGER_TOKEN": "mt",
            "ADMIN_TOKEN": "at",
        },
    )
    ready = (
        await client.post(PREVIEW_PATH, json=plan_body(seeded.target_id), headers=member_headers)
    ).json()
    assert ready["skipped"] == []
