import os
from collections.abc import AsyncIterator

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment

from tessa_api.main import create_app
from tessa_api.settings import Settings
from tessa_worker.settings import WorkerSettings
from tests.support import API_ENV_TEST, API_ROOT, TEST_LAYA_URL, WORKER_ENV_EXAMPLE

TRUNCATE_TABLES = "TRUNCATE TABLE idempotency_keys, run_events, users RESTART IDENTITY CASCADE"
INTEGRATION_FIXTURES = frozenset({"database", "temporal_env"})


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        if INTEGRATION_FIXTURES.intersection(getattr(item, "fixturenames", ())):
            item.add_marker(pytest.mark.integration)


@pytest.fixture(autouse=True)
def clean_tessa_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.upper().startswith("TESSA_"):
            monkeypatch.delenv(name)


@pytest.fixture
def api_settings() -> Settings:
    return Settings(_env_file=API_ENV_TEST)


@pytest.fixture
def worker_settings(api_settings: Settings) -> WorkerSettings:
    return WorkerSettings(
        _env_file=WORKER_ENV_EXAMPLE,
        service_key=api_settings.service_key,
        api_internal_url="http://testserver",
        database_url=api_settings.database_url,
        temporal_task_queue=api_settings.temporal_task_queue,
        data_dir=api_settings.data_dir,
        laya_url=TEST_LAYA_URL,
    )


@pytest.fixture
async def temporal_env() -> AsyncIterator[WorkflowEnvironment]:
    environment = await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    )
    yield environment
    await environment.shutdown()


@pytest.fixture(scope="session")
def migrated_database() -> None:
    settings = Settings(_env_file=API_ENV_TEST)
    config = Config(str(API_ROOT / "alembic.ini"))
    config.attributes["database_url"] = settings.database_url.get_secret_value()
    command.upgrade(config, "head")


@pytest.fixture
async def database(api_settings: Settings, migrated_database: None) -> None:
    engine = create_async_engine(api_settings.database_url.get_secret_value())
    async with engine.begin() as connection:
        await connection.execute(text(TRUNCATE_TABLES))
    await engine.dispose()


@pytest.fixture
async def api_app(api_settings: Settings, database: None) -> AsyncIterator[FastAPI]:
    application = create_app(api_settings)
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def asgi_client(api_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=api_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client
