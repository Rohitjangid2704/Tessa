import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update

from tessa_api.db.models import PersonalTokenRow, User
from tessa_api.schemas.enums import AuditAction, AuditVia, UserRole
from tessa_api.services.personal_tokens import MAX_LIVE_TOKENS_PER_USER
from tessa_api.settings import Settings
from tests.loop.support import MY_TOKENS_PATH, audit_rows, bearer, create_personal_token
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration


async def token_row(app: FastAPI, token_id: str) -> PersonalTokenRow:
    async with app.state.session_factory() as session:
        row: PersonalTokenRow | None = await session.get(PersonalTokenRow, uuid.UUID(token_id))
        assert row is not None
        return row


async def set_token(app: FastAPI, token_id: str, **values: object) -> None:
    async with app.state.session_factory() as session:
        await session.execute(
            update(PersonalTokenRow)
            .where(PersonalTokenRow.id == uuid.UUID(token_id))
            .values(**values)
        )
        await session.commit()


def error_code(response: httpx.Response) -> str:
    code: str = response.json()["error"]["code"]
    return code


async def test_a_created_token_is_shown_once_stored_as_a_hash_and_authenticates(
    client: httpx.AsyncClient,
    member: User,
    member_headers: dict[str, str],
    db_app: FastAPI,
    settings: Settings,
) -> None:
    created = await create_personal_token(client, member_headers, name="  laptop  ")
    secret = created["token"]
    item = created["item"]
    assert secret.startswith("ipt_")
    assert item["name"] == "laptop"
    assert item["state"] == "active"
    assert secret.startswith(item["prefix"])
    row = await token_row(db_app, item["id"])
    assert row.token_hash == hashlib.sha256(secret.encode()).hexdigest()
    assert secret not in row.token_hash
    lifetime = row.expires_at - row.created_at
    assert lifetime == timedelta(days=settings.personal_token_max_days)
    listed = await client.get(MY_TOKENS_PATH, headers=bearer(secret))
    assert listed.status_code == 200, listed.text
    assert [entry["id"] for entry in listed.json()["items"]] == [item["id"]]
    assert secret not in listed.text
    created_rows = await audit_rows(db_app, [AuditAction.token_created])
    assert [(row.actor_user_id, row.via) for row in created_rows] == [(member.id, AuditVia.web)]


async def test_a_personal_token_cannot_create_another_token(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    secret = (await create_personal_token(client, member_headers))["token"]
    response = await client.post(MY_TOKENS_PATH, json={"name": "more"}, headers=bearer(secret))
    assert response.status_code == 403, response.text


async def test_a_revoked_token_is_refused_and_revoking_twice_is_not_an_error(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    created = await create_personal_token(client, member_headers)
    path = f"{MY_TOKENS_PATH}/{created['item']['id']}"
    assert (await client.delete(path, headers=member_headers)).status_code == 204
    assert (await client.delete(path, headers=member_headers)).status_code == 204
    refused = await client.get(MY_TOKENS_PATH, headers=bearer(created["token"]))
    assert refused.status_code == 401
    assert error_code(refused) == "token_revoked"
    assert len(await audit_rows(db_app, [AuditAction.token_revoked])) == 1
    listed = await client.get(MY_TOKENS_PATH, headers=member_headers)
    assert listed.json()["items"][0]["state"] == "revoked"


async def test_an_expired_or_unknown_token_or_an_inactive_user_is_unauthenticated(
    client: httpx.AsyncClient,
    member: User,
    member_headers: dict[str, str],
    db_app: FastAPI,
) -> None:
    expired = await create_personal_token(client, member_headers, name="old")
    await set_token(
        db_app, expired["item"]["id"], expires_at=datetime.now(UTC) - timedelta(minutes=1)
    )
    response = await client.get(MY_TOKENS_PATH, headers=bearer(expired["token"]))
    assert response.status_code == 401
    assert error_code(response) == "token_expired"
    unknown = await client.get(MY_TOKENS_PATH, headers=bearer("ipt_" + "x" * 43))
    assert unknown.status_code == 401
    live = await create_personal_token(client, member_headers, name="live")
    async with db_app.state.session_factory() as session:
        await session.execute(update(User).where(User.id == member.id).values(is_active=False))
        await session.commit()
    inactive = await client.get(MY_TOKENS_PATH, headers=bearer(live["token"]))
    assert inactive.status_code == 401


async def test_the_lifetime_ceiling_and_the_live_token_limit_hold(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    settings: Settings,
) -> None:
    too_long = await client.post(
        MY_TOKENS_PATH,
        json={"name": "long", "expires_in_days": settings.personal_token_max_days + 1},
        headers=member_headers,
    )
    assert too_long.status_code == 422
    assert too_long.json()["error"]["details"][0]["loc"] == ["body", "expires_in_days"]
    short = await create_personal_token(client, member_headers, name="short", expires_in_days=1)
    row = await token_row(db_app, short["item"]["id"])
    assert row.expires_at - row.created_at == timedelta(days=1)
    for index in range(MAX_LIVE_TOKENS_PER_USER - 1):
        await create_personal_token(client, member_headers, name=f"t{index}")
    refused = await client.post(MY_TOKENS_PATH, json={"name": "one more"}, headers=member_headers)
    assert refused.status_code == 409
    assert error_code(refused) == "token_limit"
    await client.delete(f"{MY_TOKENS_PATH}/{short['item']['id']}", headers=member_headers)
    await create_personal_token(client, member_headers, name="after a revoke")


async def test_use_touches_last_used_at_at_most_once_a_minute(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    created = await create_personal_token(client, member_headers)
    assert (await token_row(db_app, created["item"]["id"])).last_used_at is None
    await client.get(MY_TOKENS_PATH, headers=bearer(created["token"]))
    first = (await token_row(db_app, created["item"]["id"])).last_used_at
    assert first is not None
    await client.get(MY_TOKENS_PATH, headers=bearer(created["token"]))
    assert (await token_row(db_app, created["item"]["id"])).last_used_at == first


async def test_admins_list_and_revoke_the_tokens_of_others_and_members_cannot(
    client: httpx.AsyncClient,
    member: User,
    member_headers: dict[str, str],
    admin_headers: dict[str, str],
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    db_app: FastAPI,
) -> None:
    created = await create_personal_token(client, member_headers)
    others_path = f"/api/v1/users/{member.id}/tokens"
    other_member = auth_headers(await make_user(UserRole.member))
    assert (await client.get(others_path, headers=other_member)).status_code == 403
    listed = await client.get(others_path, headers=admin_headers)
    assert [entry["id"] for entry in listed.json()["items"]] == [created["item"]["id"]]
    revoked = await client.delete(f"{others_path}/{created['item']['id']}", headers=admin_headers)
    assert revoked.status_code == 204
    assert (await client.get(MY_TOKENS_PATH, headers=bearer(created["token"]))).status_code == 401
    unknown_user = await client.get(f"/api/v1/users/{uuid.uuid4()}/tokens", headers=admin_headers)
    assert unknown_user.status_code == 404
    async with db_app.state.session_factory() as session:
        stored = await session.scalars(select(PersonalTokenRow.revoked_at))
        assert all(value is not None for value in stored)
