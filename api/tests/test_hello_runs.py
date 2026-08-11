import json
import socket
from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI
from pydantic import BaseModel
from sqlalchemy import func, select
from temporalio.client import WorkflowExecutionStatus
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment

from tessa_api.db.models import IdempotencyKey, RunEventRow
from tessa_api.errors import ApiError
from tessa_api.main import create_app
from tessa_api.schemas.enums import UserRole
from tessa_api.schemas.hello import HelloWorkflowInput
from tessa_api.services.hello import HELLO_WORKFLOW_NAME, hello_workflow_id
from tessa_api.temporal_client import TemporalGateway, temporal_unavailable
from tests.support import AuthHeaders, MakeUser, settings_with

pytestmark = pytest.mark.integration

HELLO_URL = "/api/v1/system/hello-runs"
KEY = "hello-key-0001"


class FakeTemporal:
    def __init__(self) -> None:
        self.started: list[tuple[str, dict[str, Any], str]] = []
        self.unavailable = False
        self.start_failure: Exception | None = None

    async def ensure_available(self) -> None:
        if self.unavailable:
            raise temporal_unavailable("test double is down")

    async def start_workflow(self, name: str, argument: BaseModel, workflow_id: str) -> None:
        if self.start_failure is not None:
            raise self.start_failure
        self.started.append((name, argument.model_dump(mode="json"), workflow_id))


@pytest.fixture
def temporal(db_app: FastAPI) -> FakeTemporal:
    fake = FakeTemporal()
    db_app.state.temporal = fake
    return fake


async def post_hello(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    body: dict[str, Any] | None = None,
    key: str | None = KEY,
) -> httpx.Response:
    request_headers = dict(headers)
    if key is not None:
        request_headers["Idempotency-Key"] = key
    return await client.post(HELLO_URL, json={} if body is None else body, headers=request_headers)


async def run_event_rows(app: FastAPI, run_id: str | None = None) -> list[RunEventRow]:
    statement = select(RunEventRow).order_by(RunEventRow.run_id, RunEventRow.seq)
    if run_id is not None:
        statement = statement.where(RunEventRow.run_id == UUID(run_id))
    async with app.state.session_factory() as session:
        return list((await session.scalars(statement)).all())


async def count_idempotency_keys(app: FastAPI) -> int:
    async with app.state.session_factory() as session:
        return (await session.scalar(select(func.count()).select_from(IdempotencyKey))) or 0


async def member_headers(make_user: MakeUser, auth_headers: AuthHeaders) -> dict[str, str]:
    return auth_headers(await make_user(UserRole.member))


async def test_a_member_gets_202_with_a_run_handle_and_the_workflow_is_started(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    response = await post_hello(
        client, headers, {"ticks": 7, "tick_interval_ms": 250, "include_laya": False}
    )
    assert response.status_code == 202
    handle = response.json()
    run_id = handle["run_id"]
    assert UUID(run_id).version == 7
    assert handle["workflow_id"] == f"hello-{run_id}"
    assert handle["kind"] == "hello"
    assert handle["status"] == "queued"
    assert handle["created_at"].endswith("Z")
    assert temporal.started == [
        (
            "HelloWorkflow",
            {"run_id": run_id, "ticks": 7, "tick_interval_ms": 250, "include_laya": False},
            f"hello-{run_id}",
        )
    ]


async def test_run_created_is_persisted_as_seq_1_before_the_response_returns(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    user = await make_user(UserRole.member)
    response = await post_hello(client, auth_headers(user))
    handle = response.json()
    rows = await run_event_rows(db_app, handle["run_id"])
    assert len(rows) == 1
    row = rows[0]
    assert (row.seq, row.type, row.dedupe_key) == (1, "run.created", "created")
    assert row.payload == {
        "kind": "hello",
        "target_id": None,
        "plan_id": None,
        "trigger": "api",
        "created_by": str(user.id),
        "status": "queued",
    }
    created_at = datetime.fromisoformat(handle["created_at"])
    assert timedelta(0) <= row.ts - created_at < timedelta(milliseconds=1)


async def test_the_event_is_readable_through_the_run_log_and_a_ticket_right_away(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    run_id = (await post_hello(client, headers)).json()["run_id"]
    page = await client.get(f"/api/v1/runs/{run_id}/events", headers=headers)
    assert page.status_code == 200
    assert [event["type"] for event in page.json()["items"]] == ["run.created"]
    ticket = await client.post("/api/v1/ws-tickets", json={"run_id": run_id}, headers=headers)
    assert ticket.status_code == 200


async def test_an_empty_body_uses_the_contract_defaults(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    await post_hello(client, headers, {})
    [(_, argument, _)] = temporal.started
    assert (argument["ticks"], argument["tick_interval_ms"], argument["include_laya"]) == (
        5,
        1000,
        True,
    )


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"ticks": 0}, "ticks"),
        ({"ticks": 61}, "ticks"),
        ({"tick_interval_ms": 99}, "tick_interval_ms"),
        ({"tick_interval_ms": 10001}, "tick_interval_ms"),
        ({"include_laya": "sometimes"}, "include_laya"),
    ],
)
async def test_out_of_range_input_is_422_and_starts_nothing(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    body: dict[str, Any],
    field: str,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    response = await post_hello(client, headers, body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"
    assert response.json()["error"]["details"][0]["loc"] == ["body", field]
    assert temporal.started == []
    assert await run_event_rows(db_app) == []


async def test_a_replay_with_the_same_key_returns_the_original_and_starts_nothing_new(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    body = {"ticks": 3, "tick_interval_ms": 200, "include_laya": True}
    first = await post_hello(client, headers, body)
    again = await post_hello(client, headers, body)
    assert first.status_code == again.status_code == 202
    assert "Idempotency-Replayed" not in first.headers
    assert again.headers["Idempotency-Replayed"] == "true"
    assert again.json() == first.json()
    assert len(temporal.started) == 1
    assert len(await run_event_rows(db_app)) == 1


async def test_the_same_key_with_a_different_body_is_idempotency_conflict(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    await post_hello(client, headers, {"ticks": 3})
    response = await post_hello(client, headers, {"ticks": 4})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "idempotency_conflict"
    assert len(temporal.started) == 1


async def test_two_keys_start_two_runs(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    first = await post_hello(client, headers, key="hello-key-aaaa")
    second = await post_hello(client, headers, key="hello-key-bbbb")
    assert first.json()["run_id"] != second.json()["run_id"]
    assert len(temporal.started) == 2


@pytest.mark.parametrize("key", [None, "short", "x" * 129, "has space in it"])
async def test_a_missing_or_malformed_idempotency_key_is_400(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    key: str | None,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    response = await post_hello(client, headers, key=key)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "idempotency_key_required"
    assert temporal.started == []


async def test_a_viewer_is_forbidden_and_nothing_starts(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = auth_headers(await make_user(UserRole.viewer))
    response = await post_hello(client, headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "role_required"
    assert temporal.started == []
    assert await run_event_rows(db_app) == []
    assert await count_idempotency_keys(db_app) == 0


async def test_an_admin_may_start_a_hello_run(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = auth_headers(await make_user(UserRole.admin))
    assert (await post_hello(client, headers)).status_code == 202


async def test_without_a_token_the_request_is_401(
    client: httpx.AsyncClient, db_app: FastAPI, temporal: FakeTemporal
) -> None:
    response = await post_hello(client, {})
    assert response.status_code == 401
    assert temporal.started == []


async def test_temporal_down_is_503_dependency_unavailable_with_no_event_written(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    temporal.unavailable = True
    headers = await member_headers(make_user, auth_headers)
    response = await post_hello(client, headers)
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "dependency_unavailable"
    assert error["details"][0]["loc"] == ["dependency"]
    assert error["details"][0]["code"] == "temporal"
    assert await run_event_rows(db_app) == []
    assert temporal.started == []


async def test_the_key_is_released_after_a_503_so_the_retry_runs_once_temporal_is_back(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    temporal.unavailable = True
    assert (await post_hello(client, headers)).status_code == 503
    assert await count_idempotency_keys(db_app) == 0
    temporal.unavailable = False
    retry = await post_hello(client, headers)
    assert retry.status_code == 202
    assert "Idempotency-Replayed" not in retry.headers
    assert len(temporal.started) == 1


async def test_a_failure_while_starting_marks_the_run_failed_and_releases_the_key(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    temporal.start_failure = temporal_unavailable("lost during start")
    response = await post_hello(client, headers)
    assert response.status_code == 503
    assert response.json()["error"]["details"][0]["code"] == "temporal"
    rows = await run_event_rows(db_app)
    assert [(row.seq, row.type, row.dedupe_key) for row in rows] == [
        (1, "run.created", "created"),
        (2, "run.finished", "finished"),
    ]
    assert rows[1].payload["status"] == "failed"
    assert rows[1].payload["counters"]["pass"] == 0
    assert await count_idempotency_keys(db_app) == 0


async def test_a_duplicate_workflow_id_is_409_conflict_and_the_run_is_marked_failed(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    temporal: FakeTemporal,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    temporal.start_failure = ApiError(409, "conflict", "Workflow was already started")
    response = await post_hello(client, headers)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"
    rows = await run_event_rows(db_app)
    assert [row.type for row in rows] == ["run.created", "run.finished"]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@pytest.fixture
async def offline_app(database: None) -> AsyncIterator[FastAPI]:
    settings = settings_with(temporal_address=f"127.0.0.1:{free_port()}")
    application = create_app(settings)
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def offline_client(offline_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=offline_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


async def test_the_api_boots_without_temporal_and_never_connects_at_startup(
    offline_app: FastAPI, offline_client: httpx.AsyncClient
) -> None:
    gateway: TemporalGateway = offline_app.state.temporal
    assert gateway.client is None
    assert (await offline_client.get("/health")).json() == {"status": "ok"}
    assert gateway.client is None


async def test_dependencies_report_temporal_down_while_health_stays_ok(
    offline_client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(await make_user(UserRole.viewer))
    assert (await offline_client.get("/health")).status_code == 200
    dependencies = await offline_client.get("/health/dependencies", headers=headers)
    assert dependencies.status_code == 200
    assert dependencies.json()["temporal"]["status"] == "down"
    assert dependencies.json()["db"]["status"] == "up"


async def test_a_hello_run_against_an_unreachable_temporal_is_503_and_leaves_no_trace(
    offline_app: FastAPI,
    offline_client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    headers = await member_headers(make_user, auth_headers)
    response = await post_hello(offline_client, headers)
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "dependency_unavailable"
    assert error["details"][0]["loc"] == ["dependency"]
    assert error["details"][0]["code"] == "temporal"
    assert await run_event_rows(offline_app) == []
    assert await count_idempotency_keys(offline_app) == 0
    assert (await offline_client.get("/health")).status_code == 200


@pytest.fixture
async def gateway(temporal_env: WorkflowEnvironment) -> TemporalGateway:
    return TemporalGateway(
        temporal_env.client.service_client.config.target_host, "default", "tessa-test"
    )


@pytest.fixture
async def temporal_env() -> AsyncIterator[WorkflowEnvironment]:
    environment = await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    )
    yield environment
    await environment.shutdown()


def hello_input(run_id: UUID) -> HelloWorkflowInput:
    return HelloWorkflowInput(run_id=run_id, ticks=2, tick_interval_ms=100, include_laya=False)


async def test_the_gateway_starts_the_named_workflow_on_the_task_queue_with_a_json_input(
    gateway: TemporalGateway, temporal_env: WorkflowEnvironment
) -> None:
    run_id = UUID("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11")
    await gateway.ensure_available()
    await gateway.start_workflow(
        HELLO_WORKFLOW_NAME, hello_input(run_id), hello_workflow_id(run_id)
    )
    handle = temporal_env.client.get_workflow_handle(f"hello-{run_id}")
    description = await handle.describe()
    assert description.workflow_type == "HelloWorkflow"
    assert description.task_queue == "tessa-test"
    assert description.status == WorkflowExecutionStatus.RUNNING
    first_event = await anext(handle.fetch_history_events())
    payload = first_event.workflow_execution_started_event_attributes.input.payloads[0]
    assert json.loads(payload.data) == {
        "run_id": str(run_id),
        "ticks": 2,
        "tick_interval_ms": 100,
        "include_laya": False,
    }


async def test_starting_the_same_workflow_id_twice_is_a_409_conflict(
    gateway: TemporalGateway,
) -> None:
    run_id = UUID("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e12")
    await gateway.start_workflow(
        HELLO_WORKFLOW_NAME, hello_input(run_id), hello_workflow_id(run_id)
    )
    with pytest.raises(ApiError) as caught:
        await gateway.start_workflow(
            HELLO_WORKFLOW_NAME, hello_input(run_id), hello_workflow_id(run_id)
        )
    assert caught.value.status_code == 409
    assert caught.value.code == "conflict"


async def test_reject_duplicate_also_refuses_an_id_whose_run_was_terminated(
    gateway: TemporalGateway, temporal_env: WorkflowEnvironment
) -> None:
    run_id = UUID("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e13")
    await gateway.start_workflow(
        HELLO_WORKFLOW_NAME, hello_input(run_id), hello_workflow_id(run_id)
    )
    await temporal_env.client.get_workflow_handle(f"hello-{run_id}").terminate("test")
    with pytest.raises(ApiError) as caught:
        await gateway.start_workflow(
            HELLO_WORKFLOW_NAME, hello_input(run_id), hello_workflow_id(run_id)
        )
    assert caught.value.status_code == 409


async def test_the_gateway_connects_lazily_on_first_use_and_reuses_the_client(
    gateway: TemporalGateway,
) -> None:
    assert gateway.client is None
    await gateway.ensure_available()
    first = gateway.client
    assert first is not None
    await gateway.ensure_available()
    assert gateway.client is first


async def test_an_unreachable_gateway_raises_503_temporal_and_stays_unconnected() -> None:
    gateway = TemporalGateway(f"127.0.0.1:{free_port()}", "default", "tessa")
    with pytest.raises(ApiError) as caught:
        await gateway.ensure_available()
    assert caught.value.status_code == 503
    assert caught.value.code == "dependency_unavailable"
    assert caught.value.details[0].code == "temporal"
    assert caught.value.details[0].loc == ["dependency"]
    assert gateway.client is None
