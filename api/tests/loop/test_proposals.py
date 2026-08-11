import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import update

from tessa_api.db.models import ProposalItemRow, User
from tessa_api.schemas.enums import AuditAction, ProposalItemStatus
from tests.bundle_fixtures import gracie_like_changed_zip
from tests.bundles.support import upload_zip
from tests.loop.support import (
    CREATE_ISSUE_ITEM,
    OPEN_ISSUES_ITEM,
    USERS_ITEM,
    audit_rows,
    proposal_yaml,
)
from tests.stage_two.support import CREATE_ISSUE, OPEN_ISSUES, SeededTarget, seed_gracie

pytestmark = pytest.mark.integration


def proposal_path(target_id: str) -> str:
    return f"/api/v1/targets/{target_id}/proposal"


def item_path(item_id: str) -> str:
    return f"/api/v1/proposal-items/{item_id}"


async def put_proposal(
    client: httpx.AsyncClient, headers: dict[str, str], seeded: SeededTarget, text: str
) -> httpx.Response:
    return await client.put(proposal_path(seeded.target_id), json={"yaml": text}, headers=headers)


async def stored_proposal(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    seeded: SeededTarget,
    *items: dict[str, Any],
) -> dict[str, Any]:
    response = await put_proposal(client, headers, seeded, proposal_yaml(seeded.token, *items))
    assert response.status_code == 200, response.text
    proposal: dict[str, Any] = response.json()
    return proposal


def by_key(proposal: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["key"]: item for item in proposal["items"]}


async def tick(
    client: httpx.AsyncClient, headers: dict[str, str], item_id: str, **body: Any
) -> httpx.Response:
    return await client.patch(item_path(item_id), json=body, headers=headers)


async def test_a_put_stores_the_items_in_order_as_proposed(
    client: httpx.AsyncClient,
    member: User,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    proposal = await stored_proposal(client, member_headers, seeded)
    assert proposal["source"] == "put"
    assert proposal["stale"] is False
    assert proposal["bundle_id"] == seeded.bundle_id
    assert [item["key"] for item in proposal["items"]] == [
        OPEN_ISSUES_ITEM["key"],
        CREATE_ISSUE_ITEM["key"],
        USERS_ITEM["key"],
    ]
    assert {item["status"] for item in proposal["items"]} == {"proposed"}
    first = proposal["items"][0]
    assert first["feature_ids"] == [OPEN_ISSUES]
    assert first["reasons"] == [{"code": "money_path", "note": "the count drives billing"}]
    assert first["cell_ids"]
    read = await client.get(proposal_path(seeded.target_id), headers=member_headers)
    assert read.status_code == 200
    assert read.json()["id"] == proposal["id"]
    puts = await audit_rows(db_app, [AuditAction.proposal_put])
    assert [(row.actor_user_id, row.subject_id) for row in puts] == [
        (member.id, uuid.UUID(proposal["id"]))
    ]


async def test_a_target_without_a_proposal_answers_404(
    client: httpx.AsyncClient, member_headers: dict[str, str], seeded: SeededTarget
) -> None:
    response = await client.get(proposal_path(seeded.target_id), headers=member_headers)
    assert response.status_code == 404


async def test_ticks_and_notes_carry_over_to_items_that_keep_their_key(
    client: httpx.AsyncClient,
    member: User,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    first = by_key(await stored_proposal(client, member_headers, seeded))
    selected = await tick(
        client, member_headers, first[OPEN_ISSUES_ITEM["key"]]["id"], status="selected"
    )
    assert selected.status_code == 200, selected.text
    assert selected.json()["selected_by"] == str(member.id)
    declined = await tick(
        client,
        member_headers,
        first[CREATE_ISSUE_ITEM["key"]]["id"],
        status="declined",
        note="  covered by unit tests  ",
    )
    assert declined.json()["note"] == "covered by unit tests"
    renamed_users = {**USERS_ITEM, "key": "admin-users-list-v2"}
    second = by_key(
        await stored_proposal(
            client, member_headers, seeded, OPEN_ISSUES_ITEM, CREATE_ISSUE_ITEM, renamed_users
        )
    )
    kept = second[OPEN_ISSUES_ITEM["key"]]
    assert kept["status"] == "selected"
    assert kept["selected_by"] == str(member.id)
    assert kept["id"] != first[OPEN_ISSUES_ITEM["key"]]["id"]
    assert second[CREATE_ISSUE_ITEM["key"]]["status"] == "declined"
    assert second[CREATE_ISSUE_ITEM["key"]]["note"] == "covered by unit tests"
    assert second["admin-users-list-v2"]["status"] == "proposed"
    older = await tick(client, member_headers, first[USERS_ITEM["key"]]["id"], status="selected")
    assert older.status_code == 409
    changes = await audit_rows(db_app, [AuditAction.proposal_item_changed])
    assert len(changes) == 2


async def test_resetting_an_item_clears_who_selected_it_and_its_note(
    client: httpx.AsyncClient, member_headers: dict[str, str], seeded: SeededTarget
) -> None:
    items = by_key(await stored_proposal(client, member_headers, seeded))
    item_id = items[USERS_ITEM["key"]]["id"]
    await tick(client, member_headers, item_id, status="declined", note="later")
    reset = await tick(client, member_headers, item_id, status="proposed")
    assert reset.status_code == 200
    body = reset.json()
    assert (body["status"], body["note"], body["selected_by"], body["selected_at"]) == (
        "proposed",
        None,
        None,
        None,
    )


async def test_an_authored_item_cannot_be_changed_and_authored_cannot_be_sent(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    items = by_key(await stored_proposal(client, member_headers, seeded))
    item_id = items[OPEN_ISSUES_ITEM["key"]]["id"]
    sent = await tick(client, member_headers, item_id, status="authored")
    assert sent.status_code == 422
    async with db_app.state.session_factory() as session:
        await session.execute(
            update(ProposalItemRow)
            .where(ProposalItemRow.id == uuid.UUID(item_id))
            .values(status=ProposalItemStatus.authored)
        )
        await session.commit()
    refused = await tick(client, member_headers, item_id, status="declined")
    assert refused.status_code == 409
    assert refused.json()["error"]["details"][0]["code"] == "item_authored"


async def test_a_new_bundle_makes_the_proposal_stale(
    client: httpx.AsyncClient, member_headers: dict[str, str], seeded: SeededTarget
) -> None:
    await stored_proposal(client, member_headers, seeded)
    uploaded = await upload_zip(client, member_headers, gracie_like_changed_zip(seeded.token))
    assert uploaded.status_code == 201, uploaded.text
    read = await client.get(proposal_path(seeded.target_id), headers=member_headers)
    assert read.status_code == 200, read.text
    assert read.json()["stale"] is True


async def test_an_invalid_proposal_is_refused_with_its_errors_and_nothing_is_stored(
    client: httpx.AsyncClient, member_headers: dict[str, str], seeded: SeededTarget
) -> None:
    duplicated = await put_proposal(
        client,
        member_headers,
        seeded,
        proposal_yaml(seeded.token, OPEN_ISSUES_ITEM, OPEN_ISSUES_ITEM),
    )
    assert duplicated.status_code == 422
    error = duplicated.json()["error"]
    assert error["code"] == "proposal_invalid"
    assert "duplicate_proposal_key" in [detail["code"] for detail in error["details"]]
    other = await seed_gracie(client, member_headers, name="Other")
    foreign = await put_proposal(client, member_headers, seeded, proposal_yaml(other.token))
    assert foreign.status_code == 422
    assert "proposal_target_mismatch" in [
        detail["code"] for detail in foreign.json()["error"]["details"]
    ]
    unreadable = await put_proposal(client, member_headers, seeded, "items: [")
    assert unreadable.status_code == 422
    missing = await client.get(proposal_path(seeded.target_id), headers=member_headers)
    assert missing.status_code == 404


async def test_a_plan_covers_the_selected_items_or_the_named_ones(
    client: httpx.AsyncClient, member_headers: dict[str, str], seeded: SeededTarget
) -> None:
    items = by_key(await stored_proposal(client, member_headers, seeded))
    plan_path = f"{proposal_path(seeded.target_id)}/plan"
    nothing = await client.post(plan_path, json={}, headers=member_headers)
    assert nothing.status_code == 422
    assert nothing.json()["error"]["details"][0]["code"] == "nothing_selected"
    for key in (OPEN_ISSUES_ITEM["key"], CREATE_ISSUE_ITEM["key"]):
        await tick(client, member_headers, items[key]["id"], status="selected")
    planned = await client.post(
        plan_path, json={"name": "From the proposal"}, headers=member_headers
    )
    assert planned.status_code == 201, planned.text
    plan = planned.json()
    assert plan["name"] == "From the proposal"
    assert plan["saved"] is True
    assert plan["selection"]["feature_ids"] == sorted([OPEN_ISSUES, CREATE_ISSUE])
    assert plan["selection"]["interface_mode"] == "both"
    assert plan["selection"]["depth"] == "standard"
    named = await client.post(
        plan_path, json={"item_ids": [items[USERS_ITEM["key"]]["id"]]}, headers=member_headers
    )
    assert named.status_code == 201, named.text
    assert named.json()["selection"]["interface_mode"] == "api_only"
    unknown = await client.post(
        plan_path, json={"item_ids": [str(uuid.uuid4())]}, headers=member_headers
    )
    assert unknown.status_code == 422
    assert unknown.json()["error"]["details"][0]["code"] == "item_not_found"
