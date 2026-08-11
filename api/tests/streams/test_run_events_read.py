import re
import uuid
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI

from tessa_api.schemas.enums import UserRole
from tessa_api.schemas.streams import IngestEvent
from tessa_api.streams.ingest import append_events
from tests.streams.support import make_event, new_run_id
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration

TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


async def seed_run(app: FastAPI, run_id: uuid.UUID, count: int = 7) -> None:
    events: list[IngestEvent] = []
    for index in range(1, count + 1):
        event_type = "hello.laya" if index % 3 == 0 else "hello.tick"
        events.append(make_event(run_id, f"e{index}", event_type, {"n": index}))
    await append_events(app.state.session_factory, app.state.hub, events)


async def fetch(
    client: httpx.AsyncClient, headers: dict[str, str], run_id: uuid.UUID, query: str = ""
) -> httpx.Response:
    return await client.get(f"/api/v1/runs/{run_id}/events{query}", headers=headers)


async def test_default_page_is_ascending_and_complete(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id)
    headers = auth_headers(await make_user(UserRole.viewer))
    response = await fetch(client, headers, run_id)
    assert response.status_code == 200
    page = response.json()
    assert [item["seq"] for item in page["items"]] == [1, 2, 3, 4, 5, 6, 7]
    assert page["head_seq"] == 7
    assert page["has_more"] is False


async def test_item_shape_is_the_event_envelope(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id, 1)
    headers = auth_headers(await make_user(UserRole.viewer))
    item = (await fetch(client, headers, run_id)).json()["items"][0]
    assert set(item) == {"type", "run_id", "seq", "ts", "payload"}
    assert item["run_id"] == str(run_id)
    assert item["payload"] == {"n": 1}
    assert TIMESTAMP_PATTERN.match(item["ts"])
    assert datetime.fromisoformat(item["ts"]).astimezone(UTC).year == 2026


async def test_pages_follow_after_seq_until_exhausted(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id)
    headers = auth_headers(await make_user(UserRole.viewer))
    first = (await fetch(client, headers, run_id, "?limit=3")).json()
    second = (await fetch(client, headers, run_id, "?limit=3&after_seq=3")).json()
    third = (await fetch(client, headers, run_id, "?limit=3&after_seq=6")).json()
    assert [item["seq"] for item in first["items"]] == [1, 2, 3]
    assert first["has_more"] is True
    assert [item["seq"] for item in second["items"]] == [4, 5, 6]
    assert second["has_more"] is True
    assert [item["seq"] for item in third["items"]] == [7]
    assert third["has_more"] is False
    assert first["head_seq"] == second["head_seq"] == third["head_seq"] == 7


async def test_exact_fit_page_does_not_claim_more(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id, 3)
    headers = auth_headers(await make_user(UserRole.viewer))
    page = (await fetch(client, headers, run_id, "?limit=3")).json()
    assert len(page["items"]) == 3
    assert page["has_more"] is False


async def test_descending_order_walks_back_with_before_seq(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id)
    headers = auth_headers(await make_user(UserRole.viewer))
    newest = (await fetch(client, headers, run_id, "?order=desc&limit=3")).json()
    older = (await fetch(client, headers, run_id, "?order=desc&limit=3&before_seq=5")).json()
    assert [item["seq"] for item in newest["items"]] == [7, 6, 5]
    assert newest["has_more"] is True
    assert [item["seq"] for item in older["items"]] == [4, 3, 2]
    assert older["has_more"] is True


async def test_window_between_after_and_before(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id)
    headers = auth_headers(await make_user(UserRole.viewer))
    page = (await fetch(client, headers, run_id, "?after_seq=2&before_seq=6")).json()
    assert [item["seq"] for item in page["items"]] == [3, 4, 5]
    assert page["has_more"] is False


async def test_type_filter_accepts_repeated_values_and_keeps_head_seq(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id)
    headers = auth_headers(await make_user(UserRole.viewer))
    laya = (await fetch(client, headers, run_id, "?type=hello.laya")).json()
    both = (await fetch(client, headers, run_id, "?type=hello.laya&type=hello.tick")).json()
    none = (await fetch(client, headers, run_id, "?type=run.finished")).json()
    assert [item["seq"] for item in laya["items"]] == [3, 6]
    assert len(both["items"]) == 7
    assert none["items"] == []
    assert none["head_seq"] == 7


async def test_unknown_run_is_not_found(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(await make_user(UserRole.viewer))
    response = await fetch(client, headers, new_run_id())
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_ephemeral_events_never_appear_in_the_log(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id, 2)
    ephemeral = make_event(run_id, None, "coverage.updated", ephemeral=True)
    await append_events(db_app.state.session_factory, db_app.state.hub, [ephemeral])
    headers = auth_headers(await make_user(UserRole.viewer))
    page = (await fetch(client, headers, run_id)).json()
    assert [item["type"] for item in page["items"]] == ["hello.tick", "hello.tick"]


@pytest.mark.parametrize("role", [UserRole.viewer, UserRole.member, UserRole.admin])
async def test_every_role_can_read_the_log(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    role: UserRole,
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id, 1)
    headers = auth_headers(await make_user(role))
    assert (await fetch(client, headers, run_id)).status_code == 200


async def test_log_needs_authentication(client: httpx.AsyncClient, db_app: FastAPI) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id, 1)
    response = await fetch(client, {}, run_id)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


async def test_inactive_user_is_refused(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id, 1)
    headers = auth_headers(await make_user(UserRole.viewer, is_active=False))
    assert (await fetch(client, headers, run_id)).status_code == 401


@pytest.mark.parametrize(
    "query",
    ["?limit=0", "?limit=201", "?after_seq=-1", "?before_seq=0", "?order=sideways", "?limit=abc"],
)
async def test_invalid_query_is_a_validation_error(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    query: str,
) -> None:
    headers = auth_headers(await make_user(UserRole.viewer))
    response = await fetch(client, headers, new_run_id(), query)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"


async def test_limit_of_200_is_accepted(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    run_id = new_run_id()
    await seed_run(db_app, run_id, 3)
    headers = auth_headers(await make_user(UserRole.viewer))
    assert (await fetch(client, headers, run_id, "?limit=200")).status_code == 200


async def test_malformed_run_id_is_a_validation_error(
    client: httpx.AsyncClient, db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(await make_user(UserRole.viewer))
    response = await client.get("/api/v1/runs/not-a-uuid/events", headers=headers)
    assert response.status_code == 422
