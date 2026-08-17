import asyncio
import contextlib
import os
import socket
import sys
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import httpx
import pytest
import uvicorn

from tessa_api.auth.jwt import encode_api_token
from tessa_api.auth.users import create_user
from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.main import create_app
from tessa_api.schemas.enums import AdapterKind, UserRole
from tessa_api.settings import Settings
from tessa_worker.adapters.browser import BrowserRuntime
from tessa_worker.adapters.browser_processes import SystemProcessProbe
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.settings import WorkerSettings
from tests.adapters.support import local_context
from tests.browser_site.pages import LOGIN_EMAIL, LOGIN_PASSWORD
from tests.browser_site.site import TestSite
from tests.live.live_stack import ExternalApi, LiveApi
from tests.support import API_ENV_TEST, API_ROOT

STEP_TIMEOUT_SECONDS = 10.0
HEALTH_ATTEMPTS = 600
HEALTH_PAUSE_SECONDS = 0.1


@pytest.fixture
def site() -> Iterator[TestSite]:
    with TestSite() as running:
        yield running


@pytest.fixture
def browser_settings(worker_settings: WorkerSettings, tmp_path: Path) -> WorkerSettings:
    return worker_settings.model_copy(
        update={
            "data_dir": tmp_path / "data",
            "browser_max_contexts": 2,
            "browser_headless": True,
        }
    )


@pytest.fixture
async def runtime(browser_settings: WorkerSettings) -> AsyncIterator[BrowserRuntime]:
    started = BrowserRuntime(browser_settings)
    await started.start()
    yield started
    await started.stop()


def browser_context(
    site: TestSite,
    step_timeout_seconds: float = STEP_TIMEOUT_SECONDS,
    max_payload_bytes: int = 262144,
) -> AdapterContext:
    return local_context(
        site.url,
        kind=AdapterKind.browser.value,
        base_path="/",
        values={"STAFF_EMAIL": LOGIN_EMAIL, "STAFF_PASSWORD": LOGIN_PASSWORD},
        step_timeout_seconds=step_timeout_seconds,
        max_payload_bytes=max_payload_bytes,
    )


@pytest.fixture
async def live_api(database: None) -> AsyncIterator[LiveApi]:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = int(listener.getsockname()[1])
    base_url = f"http://127.0.0.1:{port}"
    settings = Settings(_env_file=API_ENV_TEST, public_api_url=base_url)
    app = create_app(settings)
    server = uvicorn.Server(uvicorn.Config(app, log_config=None, lifespan="on"))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    while not server.started:
        if serving.done():
            serving.result()
        await asyncio.sleep(0.01)
    async with app.state.session_factory() as session:
        user = await create_user(
            session,
            email="live@tessa.test",
            name="Live",
            password="x" * 20,
            role=UserRole.member,
        )
    token = encode_api_token(settings, user.id, user.email, user.role)
    yield LiveApi(base_url, settings, user, {"Authorization": f"Bearer {token}"}, app)
    server.should_exit = True
    await serving


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#") and "=" in line:
            name, value = line.split("=", 1)
            values[name.strip()] = value
    return values


async def wait_until_healthy(base_url: str, process: asyncio.subprocess.Process) -> None:
    async with httpx.AsyncClient(timeout=5.0) as client:
        for _ in range(HEALTH_ATTEMPTS):
            if process.returncode is not None:
                raise RuntimeError(f"the API process ended with code {process.returncode}")
            with contextlib.suppress(httpx.HTTPError):
                if (await client.get(f"{base_url}/health")).status_code == 200:
                    return
            await asyncio.sleep(HEALTH_PAUSE_SECONDS)
    raise RuntimeError("the API process did not become healthy")


@pytest.fixture
async def external_api(database: None, tmp_path: Path) -> AsyncIterator[ExternalApi]:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = int(listener.getsockname()[1])
    listener.close()
    base_url = f"http://127.0.0.1:{port}"
    environment = {
        name: value
        for name, value in os.environ.items()
        if not name.upper().startswith("TESSA_")
    }
    environment.update(read_env_file(API_ENV_TEST))
    environment["TESSA_PUBLIC_API_URL"] = base_url
    environment["TESSA_DATA_DIR"] = str(tmp_path / "api-data")
    process = await asyncio.create_subprocess_exec(
        *[
            sys.executable,
            "-m",
            "uvicorn",
            "tessa_api.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=API_ROOT,
        env=environment,
    )
    try:
        await wait_until_healthy(base_url, process)
        settings = Settings(_env_file=API_ENV_TEST, public_api_url=base_url)
        engine = create_engine(settings.database_url)
        async with create_session_factory(engine)() as session:
            user = await create_user(
                session,
                email="measure@tessa.test",
                name="Measure",
                password="x" * 20,
                role=UserRole.member,
            )
        await engine.dispose()
        token = encode_api_token(settings, user.id, user.email, user.role)
        yield ExternalApi(
            base_url, settings, user, {"Authorization": f"Bearer {token}"}, process.pid
        )
    finally:
        await asyncio.to_thread(SystemProcessProbe().kill_tree, process.pid)
        await asyncio.wait_for(process.wait(), 30)
