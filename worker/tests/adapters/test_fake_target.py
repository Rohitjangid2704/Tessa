import json
from typing import Any

import httpx

from tests.fake_target.app import create_app
from tests.fake_target.chat import answer_tokens, reply_to
from tests.fake_target.dataset import (
    ADMIN_TOKEN,
    MANAGER_TOKEN,
    STAFF_EMAIL,
    STAFF_PASSWORD,
    seeded_dataset,
)
from tests.fake_target.server import RunningTarget


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def parse_events(text: str) -> list[tuple[str, dict[str, Any]]]:
    events: list[tuple[str, dict[str, Any]]] = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.split("\n"))
        events.append((lines["event"], json.loads(lines["data"])))
    return events


async def login(client: httpx.AsyncClient) -> str:
    response = await client.post(
        "/api/auth/login", json={"email": STAFF_EMAIL, "password": STAFF_PASSWORD}
    )
    assert response.status_code == 200
    return str(response.json()["access_token"])


async def test_the_health_endpoint_answers_ok(fake_target: RunningTarget) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_login_returns_a_role_token_and_a_cookie(fake_target: RunningTarget) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        token = await login(client)
        assert token.startswith("fake-session-")
        assert client.cookies.get("fake_session") == token
        assert (await client.get("/api/me", headers=bearer(token))).json() == {"role": "staff"}


async def test_a_wrong_password_is_refused(fake_target: RunningTarget) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        response = await client.post(
            "/api/auth/login", json={"email": STAFF_EMAIL, "password": "nope-nope-nope"}
        )
    assert response.status_code == 401


async def test_static_tokens_identify_the_manager_and_the_admin(
    fake_target: RunningTarget,
) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        manager = await client.get("/api/me", headers=bearer(MANAGER_TOKEN))
        admin = await client.get("/api/me", headers=bearer(ADMIN_TOKEN))
        nobody = await client.get("/api/me")
        wrong = await client.get("/api/me", headers=bearer("not-a-token"))
    assert manager.json() == {"role": "manager"}
    assert admin.json() == {"role": "admin"}
    assert nobody.status_code == 401
    assert wrong.status_code == 401


async def test_rooms_can_be_filtered_by_status(fake_target: RunningTarget) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        everything = await client.get("/api/rooms", headers=bearer(MANAGER_TOKEN))
        dirty = await client.get(
            "/api/rooms", params={"status": "dirty"}, headers=bearer(MANAGER_TOKEN)
        )
    assert everything.json()["total"] == 8
    assert [room["number"] for room in dirty.json()["items"]] == ["20002", "20003", "20005"]


async def test_only_the_admin_lists_users(fake_target: RunningTarget) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        denied = await client.get("/api/admin/users", headers=bearer(MANAGER_TOKEN))
        allowed = await client.get("/api/admin/users", headers=bearer(ADMIN_TOKEN))
    assert denied.status_code == 403
    assert allowed.json()["total"] == 3
    assert all(set(user) == {"email", "role"} for user in allowed.json()["items"])


async def test_an_issue_can_be_created_and_listed_and_reset_restores_the_seed(
    fake_target: RunningTarget,
) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        before = (await client.get("/qa/hash")).json()["hash"]
        created = await client.post(
            "/api/issues",
            json={"room": "20001", "description": "window stuck"},
            headers=bearer(MANAGER_TOKEN),
        )
        open_after = await client.get(
            "/api/issues", params={"status": "open"}, headers=bearer(MANAGER_TOKEN)
        )
        changed = (await client.get("/qa/hash")).json()["hash"]
        reset = (await client.post("/qa/reset")).json()["hash"]
    assert created.status_code == 201
    assert open_after.json()["total"] == 4
    assert changed != before
    assert reset == before


async def test_issue_creation_validates_the_room_and_the_role(fake_target: RunningTarget) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        unknown = await client.post(
            "/api/issues",
            json={"room": "99999", "description": "x"},
            headers=bearer(MANAGER_TOKEN),
        )
        admin = await client.post(
            "/api/issues",
            json={"room": "20001", "description": "x"},
            headers=bearer(ADMIN_TOKEN),
        )
        anonymous = await client.post("/api/issues", json={"room": "20001", "description": "x"})
    assert unknown.status_code == 422
    assert admin.status_code == 403
    assert anonymous.status_code == 401


async def test_the_chat_stream_emits_tool_tokens_card_and_done_in_order(
    fake_target: RunningTarget,
) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        response = await client.post(
            "/api/chat/message",
            json={"message": "Which maintenance issues are still open?"},
            headers=bearer(MANAGER_TOKEN),
        )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    events = parse_events(response.text)
    names = [name for name, _ in events]
    assert names[0] == "tool_call"
    assert names[-2:] == ["card", "done"]
    assert set(names[1:-2]) == {"token"}
    text = "".join(data["text"] for name, data in events if name == "token")
    assert text.startswith("3 maintenance issues are open across 2 rooms")


async def test_the_chat_requires_a_message_and_a_login(fake_target: RunningTarget) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        anonymous = await client.post("/api/chat/message", json={"message": "hi"})
        empty = await client.post(
            "/api/chat/message", json={"message": ""}, headers=bearer(MANAGER_TOKEN)
        )
    assert anonymous.status_code == 401
    assert empty.status_code == 422


def test_answers_come_from_the_dataset_so_they_move_with_it() -> None:
    dataset = seeded_dataset()
    assert (
        "3 maintenance issues are open across 2 rooms"
        in reply_to("Which maintenance issues are still open?", dataset).answer
    )
    for issue in dataset.issues:
        issue.status = "closed"
    assert reply_to("Which maintenance issues are still open?", dataset).answer == (
        "No maintenance issues are open."
    )
    dataset.add_issue("20008", "lamp")
    assert reply_to("Which maintenance issues are still open?", dataset).answer == (
        "1 maintenance issue is open across 1 room, most of them in room 20008 (1 issue)."
    )


def test_a_singular_and_an_empty_dirty_list_are_worded_correctly() -> None:
    dataset = seeded_dataset()
    dataset.rooms = [room for room in dataset.rooms if room.number != "20002"]
    assert reply_to("Which rooms are dirty?", dataset).answer == "2 rooms are dirty: 20003, 20005."
    dataset.rooms = [room for room in dataset.rooms if room.number == "20003"]
    assert reply_to("Which rooms are dirty?", dataset).answer == "1 room is dirty: 20003."
    dataset.rooms = []
    assert reply_to("Which rooms are dirty?", dataset).answer == "No rooms are dirty."


def test_a_write_request_never_claims_the_issue_exists() -> None:
    reply = reply_to(
        "Create a maintenance issue for room 20003, the shower leaks", seeded_dataset()
    )
    assert "Please confirm" in reply.answer
    assert reply.cards == [
        {
            "kind": "confirmation",
            "action": "create_issue",
            "room": "20003",
            "description": "the shower leaks",
        }
    ]
    unknown = reply_to("Create a maintenance issue for room 99999, broken", seeded_dataset())
    assert unknown.cards == []


def test_the_leaky_question_shows_an_internal_id_and_a_uuid() -> None:
    answer = reply_to("What is the internal id of room 20003?", seeded_dataset()).answer
    assert "room_id 4002" in answer
    assert "-" in answer


def test_tokens_rebuild_the_answer_exactly() -> None:
    answer = "3 rooms are dirty: 20002, 20003, 20005."
    assert "".join(answer_tokens(answer)) == answer
    assert len(answer_tokens(answer)) == len(answer.split(" "))


async def test_the_pages_have_the_selector_contract(fake_target: RunningTarget) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        login_page = await client.get("/login")
        anonymous_chat = await client.get("/chat")
        token = await login(client)
        chat_page = await client.get("/chat")
    assert 'data-testid="password"' in login_page.text
    assert '<label for="email">Email</label>' in login_page.text
    assert '<button type="submit">Sign in</button>' in login_page.text
    assert anonymous_chat.status_code == 302
    assert anonymous_chat.headers["location"] == "/login"
    assert token
    assert chat_page.status_code == 200
    for contract in ('data-testid="chat-input"', 'data-testid="send"', 'data-testid="chat-log"'):
        assert contract in chat_page.text


async def test_the_server_records_what_it_received(fake_target: RunningTarget) -> None:
    async with httpx.AsyncClient(base_url=fake_target.base_url) as client:
        await client.get("/health", headers={"X-Probe": "yes"})
    recorded = [r for r in fake_target.state.requests if r.path == "/health"]
    assert recorded[-1].method == "GET"
    assert recorded[-1].headers["x-probe"] == "yes"


def test_the_app_can_be_built_without_a_server() -> None:
    app = create_app()
    assert app.title == "Fake target"
