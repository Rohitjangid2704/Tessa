import uuid

import httpx
import pytest
from fastapi import FastAPI

from tessa_api.db.models import AgentSessionRow, User
from tessa_api.schemas.enums import AuditAction, AuditSubjectType, AuditVia
from tests.bundle_fixtures import gracie_like_zip
from tests.bundles.support import upload_zip
from tests.loop.support import audit_rows, bearer, create_personal_token
from tests.stage_one import TARGETS_PATH
from tests.stage_two.support import SeededTarget

pytestmark = pytest.mark.integration

LEDGER = [AuditAction.personal_token_write]
AGENT_SESSIONS_PATH = "/api/v1/agent-sessions"


def target_body(name: str = "Ledger") -> dict[str, str]:
    return {"name": name, "app_kind": "llm_assistant"}


async def personal_headers(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> dict[str, str]:
    return bearer((await create_personal_token(client, member_headers))["token"])


async def open_agent_session(client: httpx.AsyncClient, headers: dict[str, str]) -> str:
    response = await client.post(
        AGENT_SESSIONS_PATH,
        json={"claude_session_id": "cc-1", "cwd_label": "gracie", "plugin_version": "0.1.0"},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    session_id: str = response.json()["id"]
    return session_id


async def test_a_write_with_a_personal_token_leaves_exactly_one_ledger_row(
    client: httpx.AsyncClient,
    member: User,
    member_headers: dict[str, str],
    db_app: FastAPI,
) -> None:
    headers = await personal_headers(client, member_headers)
    response = await client.post(TARGETS_PATH, json=target_body(), headers=headers)
    assert response.status_code == 201, response.text
    rows = await audit_rows(db_app, LEDGER)
    assert len(rows) == 1
    row = rows[0]
    assert row.actor_user_id == member.id
    assert row.via is AuditVia.mcp
    assert row.subject_type is AuditSubjectType.route
    assert row.subject_id == uuid.UUID(response.json()["id"])
    assert row.agent_session_id is None
    assert row.detail["method"] == "POST"
    assert row.detail["path"] == TARGETS_PATH
    assert row.detail["status"] == 201


async def test_the_same_write_with_a_session_token_or_a_read_leaves_no_ledger_row(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    created = await client.post(TARGETS_PATH, json=target_body(), headers=member_headers)
    assert created.status_code == 201
    headers = await personal_headers(client, member_headers)
    assert (await client.get(TARGETS_PATH, headers=headers)).status_code == 200
    assert await audit_rows(db_app, LEDGER) == []


async def test_a_refused_write_leaves_no_ledger_row(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    headers = await personal_headers(client, member_headers)
    refused = await client.post(TARGETS_PATH, json={"name": ""}, headers=headers)
    assert refused.status_code == 422
    assert await audit_rows(db_app, LEDGER) == []


async def test_the_routes_that_store_nothing_leave_no_ledger_row(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    headers = await personal_headers(client, member_headers)
    validated = await client.post(
        "/api/v1/bundles/validate",
        files={"file": ("tessa.zip", gracie_like_zip(seeded.token), "application/zip")},
        headers=headers,
    )
    assert validated.status_code == 200, validated.text
    scenario = await client.post(
        "/api/v1/scenarios/validate",
        json={"target_id": seeded.target_id, "yaml": "schema_version: 1\n"},
        headers=headers,
    )
    assert scenario.status_code == 200, scenario.text
    session_id = await open_agent_session(client, headers)
    ended = await client.patch(
        f"{AGENT_SESSIONS_PATH}/{session_id}",
        json={"summary": "validated the bundle", "ended_at": "2026-10-14T10:00:00Z"},
        headers=headers,
    )
    assert ended.status_code == 200, ended.text
    assert await audit_rows(db_app, LEDGER) == []


async def test_an_idempotent_replay_is_not_recorded_twice(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    headers = await personal_headers(client, member_headers)
    archive = gracie_like_zip(seeded.token)
    first = await upload_zip(client, headers, archive, key="ledger-upload")
    replay = await upload_zip(client, headers, archive, key="ledger-upload")
    assert first.status_code in (200, 201), first.text
    assert replay.status_code == first.status_code
    assert replay.headers.get("Idempotency-Replayed") == "true"
    assert len(await audit_rows(db_app, LEDGER)) == 1


async def test_a_write_inside_an_agent_session_is_counted_on_that_session(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    headers = await personal_headers(client, member_headers)
    session_id = await open_agent_session(client, headers)
    in_session = {**headers, "X-Agent-Session": session_id}
    for name in ("one", "two"):
        response = await client.post(TARGETS_PATH, json=target_body(name), headers=in_session)
        assert response.status_code == 201, response.text
    rows = await audit_rows(db_app, LEDGER)
    assert [row.agent_session_id for row in rows] == [uuid.UUID(session_id)] * 2
    async with db_app.state.session_factory() as session:
        stored = await session.get(AgentSessionRow, uuid.UUID(session_id))
        assert stored is not None
        assert stored.write_count == 2


async def test_an_agent_session_header_of_another_user_is_ignored(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    admin_headers: dict[str, str],
    db_app: FastAPI,
) -> None:
    foreign_session = await open_agent_session(
        client, bearer((await create_personal_token(client, admin_headers))["token"])
    )
    headers = await personal_headers(client, member_headers)
    response = await client.post(
        TARGETS_PATH, json=target_body(), headers={**headers, "X-Agent-Session": foreign_session}
    )
    assert response.status_code == 201
    rows = await audit_rows(db_app, LEDGER)
    assert [row.agent_session_id for row in rows] == [None]
