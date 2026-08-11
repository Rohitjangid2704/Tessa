import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import select, update

from tessa_api.db.models import IdempotencyKey
from tessa_api.deps import IdempotencyDep, MemberUser
from tessa_api.errors import ApiError, dependency_unavailable
from tessa_api.ids import new_id
from tessa_api.schemas.common import RunHandle
from tessa_api.schemas.enums import RunKind, RunStatus
from tessa_api.schemas.hello import HelloRunCreate
from tessa_api.services.idempotency import (
    abandon,
    begin,
    compute_request_hash,
)
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration

PATH = "/__test/idempotent"


class Probe:
    def __init__(self) -> None:
        self.calls = 0
        self.fail_next = False
        self.gate: asyncio.Event | None = None
        self.entered = asyncio.Event()


def install_route(app: FastAPI, probe: Probe) -> None:
    async def handler(
        body: HelloRunCreate, user: MemberUser, idempotency: IdempotencyDep
    ) -> JSONResponse:
        probe.calls += 1
        probe.entered.set()
        if probe.gate is not None:
            await probe.gate.wait()
        if probe.fail_next:
            probe.fail_next = False
            raise dependency_unavailable("temporal", "Temporal is not reachable")
        handle = RunHandle(
            run_id=new_id(),
            workflow_id=f"hello-{body.ticks}",
            kind=RunKind.hello,
            status=RunStatus.queued,
            created_at=datetime.now(UTC),
        )
        return await idempotency.respond(handle, 202)

    app.add_api_route(PATH, handler, methods=["POST"], status_code=202)
    app.add_api_route(PATH + "-other", handler, methods=["POST"], status_code=202)


def key_headers(auth: dict[str, str], key: str = "key-0000001") -> dict[str, str]:
    return {**auth, "Idempotency-Key": key}


async def test_first_request_runs_and_replay_returns_the_original(
    db_app: FastAPI, client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    probe = Probe()
    install_route(db_app, probe)
    headers = key_headers(auth_headers(await make_user()))
    first = await client.post(PATH, json={"ticks": 3}, headers=headers)
    second = await client.post(PATH, json={"ticks": 3}, headers=headers)
    assert first.status_code == 202
    assert "idempotency-replayed" not in first.headers
    assert second.status_code == 202
    assert second.headers["idempotency-replayed"] == "true"
    assert second.json() == first.json()
    assert probe.calls == 1


async def test_same_key_with_a_different_body_conflicts(
    db_app: FastAPI, client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    probe = Probe()
    install_route(db_app, probe)
    headers = key_headers(auth_headers(await make_user()))
    await client.post(PATH, json={"ticks": 3}, headers=headers)
    response = await client.post(PATH, json={"ticks": 4}, headers=headers)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "idempotency_conflict"
    assert probe.calls == 1


async def test_same_key_on_a_different_path_conflicts(
    db_app: FastAPI, client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    probe = Probe()
    install_route(db_app, probe)
    headers = key_headers(auth_headers(await make_user()))
    await client.post(PATH, json={"ticks": 3}, headers=headers)
    response = await client.post(PATH + "-other", json={"ticks": 3}, headers=headers)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "idempotency_conflict"


async def test_request_in_progress_is_a_conflict_with_retry_after(
    db_app: FastAPI, client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    probe = Probe()
    probe.gate = asyncio.Event()
    install_route(db_app, probe)
    headers = key_headers(auth_headers(await make_user()))
    running = asyncio.create_task(client.post(PATH, json={"ticks": 3}, headers=headers))
    await asyncio.wait_for(probe.entered.wait(), timeout=10)
    blocked = await client.post(PATH, json={"ticks": 3}, headers=headers)
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "conflict"
    assert blocked.headers["retry-after"] == "1"
    probe.gate.set()
    finished = await running
    assert finished.status_code == 202
    replay = await client.post(PATH, json={"ticks": 3}, headers=headers)
    assert replay.headers["idempotency-replayed"] == "true"
    assert probe.calls == 1


async def test_missing_or_malformed_key_is_idempotency_key_required(
    db_app: FastAPI, client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    install_route(db_app, Probe())
    auth = auth_headers(await make_user())
    candidates = [auth, key_headers(auth, "short"), key_headers(auth, "x" * 129)]
    for headers in candidates:
        response = await client.post(PATH, json={"ticks": 3}, headers=headers)
        assert response.status_code == 400, headers
        assert response.json()["error"]["code"] == "idempotency_key_required"


async def test_authentication_is_checked_before_the_key(
    db_app: FastAPI, client: httpx.AsyncClient
) -> None:
    install_route(db_app, Probe())
    response = await client.post(PATH, json={"ticks": 3})
    assert response.status_code == 401


async def test_keys_are_scoped_per_user(
    db_app: FastAPI, client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    probe = Probe()
    install_route(db_app, probe)
    first_user = key_headers(auth_headers(await make_user()))
    second_user = key_headers(auth_headers(await make_user()))
    await client.post(PATH, json={"ticks": 3}, headers=first_user)
    response = await client.post(PATH, json={"ticks": 3}, headers=second_user)
    assert response.status_code == 202
    assert "idempotency-replayed" not in response.headers
    assert probe.calls == 2


async def test_failed_request_releases_the_key_for_a_retry(
    db_app: FastAPI, client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    probe = Probe()
    probe.fail_next = True
    install_route(db_app, probe)
    headers = key_headers(auth_headers(await make_user()))
    failed = await client.post(PATH, json={"ticks": 3}, headers=headers)
    assert failed.status_code == 503
    retried = await client.post(PATH, json={"ticks": 3}, headers=headers)
    assert retried.status_code == 202
    assert "idempotency-replayed" not in retried.headers
    assert probe.calls == 2


async def test_stored_row_keeps_the_contract_columns(
    db_app: FastAPI, client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    install_route(db_app, Probe())
    user = await make_user()
    response = await client.post(
        PATH, json={"ticks": 3}, headers=key_headers(auth_headers(user), "stored-key-1")
    )
    async with db_app.state.session_factory() as session:
        row = await session.scalar(select(IdempotencyKey))
    assert row is not None
    assert (row.user_id, row.key, row.method, row.path) == (user.id, "stored-key-1", "POST", PATH)
    assert row.response_status == 202
    assert row.response_body == response.json()
    assert row.expires_at - row.created_at > timedelta(hours=23)


async def test_begin_accepts_a_precomputed_request_hash(
    db_app: FastAPI, make_user: MakeUser
) -> None:
    user = await make_user()
    factory = db_app.state.session_factory
    first = await begin(factory, user.id, "upload-key-1", "POST", "/up", "hash-of-file-a", 24)
    assert first is None
    with pytest.raises(ApiError) as same_hash:
        await begin(factory, user.id, "upload-key-1", "POST", "/up", "hash-of-file-a", 24)
    assert same_hash.value.code == "conflict"
    with pytest.raises(ApiError) as other_hash:
        await begin(factory, user.id, "upload-key-1", "POST", "/up", "hash-of-file-b", 24)
    assert other_hash.value.code == "idempotency_conflict"


async def test_expired_rows_are_deleted_on_insert_and_the_key_is_reusable(
    db_app: FastAPI, make_user: MakeUser
) -> None:
    user = await make_user()
    factory = db_app.state.session_factory
    await begin(factory, user.id, "old-key-0001", "POST", "/x", "h1", 24)
    async with factory() as session:
        await session.execute(
            update(IdempotencyKey).values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await session.commit()
    assert await begin(factory, user.id, "old-key-0001", "POST", "/x", "h2", 24) is None
    async with factory() as session:
        rows = list(await session.scalars(select(IdempotencyKey)))
    assert [(row.key, row.request_hash) for row in rows] == [("old-key-0001", "h2")]


async def test_abandon_only_removes_unfinished_rows(db_app: FastAPI, make_user: MakeUser) -> None:
    user = await make_user()
    factory = db_app.state.session_factory
    await begin(factory, user.id, "done-key-001", "POST", "/x", "h", 24)
    async with factory() as session:
        await session.execute(update(IdempotencyKey).values(response_status=200, response_body={}))
        await session.commit()
    await abandon(factory, user.id, "done-key-001")
    async with factory() as session:
        assert len(list(await session.scalars(select(IdempotencyKey)))) == 1


def test_request_hash_depends_on_method_path_and_body() -> None:
    base = compute_request_hash("POST", "/a", b"{}")
    assert compute_request_hash("post", "/a", b"{}") == base
    assert compute_request_hash("PUT", "/a", b"{}") != base
    assert compute_request_hash("POST", "/b", b"{}") != base
    assert compute_request_hash("POST", "/a", b"{ }") != base


async def test_concurrent_begin_lets_exactly_one_caller_proceed(
    db_app: FastAPI, make_user: MakeUser
) -> None:
    user = await make_user()
    factory = db_app.state.session_factory

    async def attempt() -> str:
        try:
            outcome = await begin(factory, user.id, "race-key-001", "POST", "/x", "h", 24)
        except ApiError as error:
            return error.code
        return "owner" if outcome is None else "replay"

    results = await asyncio.gather(*(attempt() for _ in range(8)))
    assert results.count("owner") == 1
    assert results.count("conflict") == 7
