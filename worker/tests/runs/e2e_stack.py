import asyncio
import socket
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
import uvicorn
from temporalio.testing import WorkflowEnvironment

from tessa_api.auth.jwt import encode_api_token
from tessa_api.auth.users import create_user
from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.main import create_app
from tessa_api.schemas.enums import UserRole
from tessa_api.settings import Settings
from tessa_worker.adapters.browser import BrowserRuntime
from tessa_worker.live.uplink import FrameUplink
from tessa_worker.main import build_worker, default_services
from tessa_worker.settings import WorkerSettings
from tests.adapters.support import fake_target_values
from tests.fake_target.app import TOKEN_DELAY_SECONDS
from tests.fake_target.app import create_app as create_app_for_target
from tests.fake_target.bundle import build_bundle_zip
from tests.fake_target.server import RunningTarget
from tests.support import API_ENV_TEST, TEST_LAYA_URL, WORKER_ENV_EXAMPLE

WAIT_SECONDS = 90.0
CLIENT_TIMEOUT_SECONDS = 60.0
POLL_SECONDS = 0.1
TERMINAL_STATUSES = {"completed", "failed", "canceled", "budget_exceeded"}
TASK_QUEUE = "tessa-runs-e2e"


@dataclass
class Stack:
    base_url: str
    headers: dict[str, str]
    target_id: str
    settings: Settings
    target: RunningTarget
    worker_settings: WorkerSettings


def laya_is_down(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("Laya is not running in the test stack", request=request)


@asynccontextmanager
async def open_stack(
    temporal_env: WorkflowEnvironment,
    target_delay: float = TOKEN_DELAY_SECONDS,
    with_browser: bool = False,
    max_contexts: int | None = None,
    latency_limit_ms: int | None = None,
) -> AsyncIterator[Stack]:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = int(listener.getsockname()[1])
    base_url = f"http://127.0.0.1:{port}"
    api_settings = Settings(
        _env_file=API_ENV_TEST,
        public_api_url=base_url,
        temporal_address=temporal_env.client.service_client.config.target_host,
        temporal_task_queue=TASK_QUEUE,
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
            session,
            email="runs-e2e@tessa.test",
            name="E2E",
            password="x" * 20,
            role=UserRole.member,
        )
    token = encode_api_token(api_settings, user.id, user.email, user.role)
    headers = {"Authorization": f"Bearer {token}"}
    overrides: dict[str, Any] = {}
    if max_contexts is not None:
        overrides["browser_max_contexts"] = max_contexts
    if latency_limit_ms is not None:
        overrides["invariant_latency_ms"] = latency_limit_ms
    worker_settings = WorkerSettings(
        _env_file=WORKER_ENV_EXAMPLE,
        service_key=api_settings.service_key,
        vault_key=api_settings.vault_key,
        data_dir=api_settings.data_dir,
        database_url=api_settings.database_url,
        api_internal_url=base_url,
        temporal_task_queue=TASK_QUEUE,
        browser_headless=True,
        laya_url=TEST_LAYA_URL,
        **overrides,
    )
    engine = create_engine(worker_settings.database_url)
    browser = (
        BrowserRuntime(worker_settings, FrameUplink(worker_settings)) if with_browser else None
    )
    try:
        if browser is not None:
            await browser.start()
        with RunningTarget(create_app_for_target(token_delay=target_delay)) as target:
            async with (
                httpx.AsyncClient() as api_http,
                httpx.AsyncClient(transport=httpx.MockTransport(laya_is_down)) as laya_http,
                build_worker(
                    temporal_env.client,
                    default_services(
                        worker_settings,
                        api_http,
                        laya_http,
                        create_session_factory(engine),
                        browser,
                    ),
                ),
                httpx.AsyncClient(
                    base_url=base_url, headers=headers, timeout=CLIENT_TIMEOUT_SECONDS
                ) as client,
            ):
                target_id = await register_target(client, target)
                yield Stack(base_url, headers, target_id, api_settings, target, worker_settings)
    finally:
        if browser is not None:
            await browser.stop()
        await engine.dispose()
        server.should_exit = True
        await serving


async def register_target(client: httpx.AsyncClient, target: RunningTarget) -> str:
    created = await client.post(
        "/api/v1/targets", json={"name": "Fake Target", "app_kind": "llm_assistant"}
    )
    assert created.status_code == 201, created.text
    body = created.json()
    uploaded = await client.post(
        "/api/v1/bundles",
        files={
            "file": ("tessa.zip", build_bundle_zip(body["target_token"]), "application/zip")
        },
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert uploaded.status_code == 201, uploaded.text
    patched = await client.patch(
        f"/api/v1/targets/{body['id']}/environment",
        json={"set": fake_target_values(target.base_url)},
    )
    assert patched.status_code == 200, patched.text
    return str(body["id"])


def plan_body(
    target_id: str, feature_ids: list[str], k: int = 1, interface_mode: str = "api_only"
) -> dict[str, Any]:
    return {
        "plan": {
            "target_id": target_id,
            "saved": False,
            "selection": {
                "feature_ids": feature_ids,
                "area_ids": [],
                "roles": ["all"],
                "interface_mode": interface_mode,
                "depth": "smoke",
                "k": k,
            },
        }
    }


def stack_client(stack: Stack) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=stack.base_url, headers=stack.headers, timeout=CLIENT_TIMEOUT_SECONDS
    )


async def start_run(client: httpx.AsyncClient, body: dict[str, Any]) -> str:
    response = await client.post(
        "/api/v1/runs", json=body, headers={"Idempotency-Key": str(uuid.uuid4())}
    )
    assert response.status_code == 202, response.text
    return str(response.json()["run_id"])


async def wait_for_terminal(client: httpx.AsyncClient, run_id: str) -> dict[str, Any]:
    async with asyncio.timeout(WAIT_SECONDS):
        while True:
            response = await client.get(f"/api/v1/runs/{run_id}")
            run: dict[str, Any] = response.json()
            if run["status"] in TERMINAL_STATUSES:
                return run
            await asyncio.sleep(POLL_SECONDS)


async def read_events(client: httpx.AsyncClient, run_id: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    while True:
        params: dict[str, Any] = {"limit": 200}
        if events:
            params["after_seq"] = events[-1]["seq"]
        response = await client.get(f"/api/v1/runs/{run_id}/events", params=params)
        page = response.json()
        events.extend(page["items"])
        if not page["has_more"]:
            return events
