import asyncio
import json
import socket
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
import uvicorn
from temporalio.testing import WorkflowEnvironment
from websockets.asyncio.client import connect

from tessa_api.auth.jwt import encode_api_token
from tessa_api.auth.users import create_user
from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.main import create_app
from tessa_api.schemas.enums import UserRole
from tessa_api.schemas.hello import HelloWorkflowResult
from tessa_api.settings import Settings
from tessa_worker.main import build_worker, default_services
from tessa_worker.settings import WorkerSettings
from tests.support import API_ENV_TEST, WORKER_ENV_EXAMPLE

pytestmark = pytest.mark.e2e

EXPECTED_TYPES = [
    "run.created",
    "run.status_changed",
    "hello.tick",
    "hello.tick",
    "hello.tick",
    "hello.laya",
    "run.finished",
]
HELLO_BODY = {"ticks": 3, "tick_interval_ms": 100, "include_laya": True}
LAYA_ANSWER = {"answers": {"smoke": {"type": "noul", "noul": 0.93}}}
WAIT_SECONDS = 15.0
CLIENT_TIMEOUT_SECONDS = 60.0


@dataclass
class Stack:
    base_url: str
    headers: dict[str, str]
    settings: Settings


def laya_stub(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=LAYA_ANSWER)


@pytest.fixture
async def stack(temporal_env: WorkflowEnvironment, database: None) -> AsyncIterator[Stack]:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = int(listener.getsockname()[1])
    base_url = f"http://127.0.0.1:{port}"
    api_settings = Settings(
        _env_file=API_ENV_TEST,
        public_api_url=base_url,
        temporal_address=temporal_env.client.service_client.config.target_host,
        temporal_task_queue="tessa-e2e",
    )
    app = create_app(api_settings)
    server = uvicorn.Server(uvicorn.Config(app, log_config=None, lifespan="on"))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    while not server.started:
        if serving.done():
            serving.result()
        await asyncio.sleep(0.01)
    async with app.state.session_factory() as session:
        user = await create_user(
            session, email="e2e@tessa.test", name="E2E", password="x" * 20, role=UserRole.member
        )
    token = encode_api_token(api_settings, user.id, user.email, user.role)
    worker_settings = WorkerSettings(
        _env_file=WORKER_ENV_EXAMPLE,
        service_key=api_settings.service_key,
        api_internal_url=base_url,
        temporal_task_queue="tessa-e2e",
        database_url=api_settings.database_url,
        data_dir=api_settings.data_dir,
    )
    engine = create_engine(worker_settings.database_url)
    async with (
        httpx.AsyncClient() as api_http,
        httpx.AsyncClient(transport=httpx.MockTransport(laya_stub)) as laya_http,
        build_worker(
            temporal_env.client,
            default_services(worker_settings, api_http, laya_http, create_session_factory(engine)),
        ),
    ):
        yield Stack(base_url, {"Authorization": f"Bearer {token}"}, api_settings)
    await engine.dispose()
    server.should_exit = True
    await serving


async def start_hello_run(stack: Stack, key: str) -> httpx.Response:
    async with httpx.AsyncClient(base_url=stack.base_url, timeout=CLIENT_TIMEOUT_SECONDS) as client:
        return await client.post(
            "/api/v1/system/hello-runs",
            json=HELLO_BODY,
            headers={**stack.headers, "Idempotency-Key": key},
        )


async def read_events_until_finished(stack: Stack, run_id: str) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(base_url=stack.base_url, timeout=CLIENT_TIMEOUT_SECONDS) as client:
        async with asyncio.timeout(WAIT_SECONDS):
            while True:
                response = await client.get(
                    f"/api/v1/runs/{run_id}/events", params={"limit": 200}, headers=stack.headers
                )
                items: list[dict[str, Any]] = response.json()["items"]
                if items and items[-1]["type"] == "run.finished":
                    return items
                await asyncio.sleep(0.05)


async def test_a_hello_run_streams_the_full_event_sequence_through_api_temporal_and_worker(
    stack: Stack,
) -> None:
    response = await start_hello_run(stack, "e2e-hello-key-0001")
    assert response.status_code == 202
    handle = response.json()
    assert handle["kind"] == "hello"
    assert handle["status"] == "queued"
    assert handle["workflow_id"] == f"hello-{handle['run_id']}"
    events = await read_events_until_finished(stack, handle["run_id"])
    assert [event["type"] for event in events] == EXPECTED_TYPES
    assert [event["seq"] for event in events] == list(range(1, 8))
    laya_event = next(event for event in events if event["type"] == "hello.laya")
    assert laya_event["payload"]["ok"] is True
    assert laya_event["payload"]["status_code"] == 200
    assert laya_event["payload"]["error"] is None
    finished = events[-1]["payload"]
    assert finished["status"] == "completed"


async def test_a_replayed_start_returns_the_same_run_and_starts_no_second_workflow(
    stack: Stack, temporal_env: WorkflowEnvironment
) -> None:
    first = await start_hello_run(stack, "e2e-hello-key-0002")
    again = await start_hello_run(stack, "e2e-hello-key-0002")
    assert again.status_code == 202
    assert again.headers["Idempotency-Replayed"] == "true"
    assert again.json() == first.json()
    run_id = first.json()["run_id"]
    events = await read_events_until_finished(stack, run_id)
    assert [event["seq"] for event in events] == list(range(1, 8))
    handle = temporal_env.client.get_workflow_handle(
        first.json()["workflow_id"], result_type=HelloWorkflowResult
    )
    result = await handle.result()
    assert result.ticks_emitted == 3
    assert result.laya is not None
    assert result.laya.ok is True


async def test_a_websocket_tail_sees_the_persisted_events_in_order_without_gaps(
    stack: Stack,
) -> None:
    response = await start_hello_run(stack, "e2e-hello-key-0003")
    run_id = response.json()["run_id"]
    async with httpx.AsyncClient(base_url=stack.base_url, timeout=CLIENT_TIMEOUT_SECONDS) as client:
        ticket = (
            await client.post("/api/v1/ws-tickets", json={"run_id": run_id}, headers=stack.headers)
        ).json()
    received: list[dict[str, Any]] = []
    async with connect(f"{ticket['ws_url']}&last_seq=0") as socket_connection:
        async with asyncio.timeout(WAIT_SECONDS):
            while True:
                event = json.loads(await socket_connection.recv())
                received.append(event)
                if event["type"] == "run.finished":
                    break
    persisted = [event for event in received if event["seq"] is not None]
    assert [event["type"] for event in persisted] == EXPECTED_TYPES
    assert [event["seq"] for event in persisted] == list(range(1, 8))
    assert received[0]["type"] == "stream.hello"
