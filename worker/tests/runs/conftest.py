from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
from fastapi import FastAPI

from tessa_api.db.session import SessionFactory, create_engine, create_session_factory
from tessa_api.settings import Settings
from tessa_worker.event_client import EventClient
from tessa_worker.settings import WorkerSettings
from tests.adapters.support import RegisteredTarget, register_fake_target
from tests.fake_target.server import RunningTarget
from tests.runs.support import FAST_DELIVERY, RecordingIngest


@pytest.fixture
async def session_factory(api_settings: Settings, database: None) -> AsyncIterator[SessionFactory]:
    engine = create_engine(api_settings.database_url)
    yield create_session_factory(engine)
    await engine.dispose()


@pytest.fixture
def ingest() -> RecordingIngest:
    return RecordingIngest()


@pytest.fixture
async def event_client(
    worker_settings: WorkerSettings, ingest: RecordingIngest
) -> AsyncIterator[EventClient]:
    transport = httpx.MockTransport(ingest.handle)
    async with httpx.AsyncClient(transport=transport) as http:
        yield EventClient(worker_settings, http, FAST_DELIVERY)


@pytest.fixture
def fake_target() -> Iterator[RunningTarget]:
    with RunningTarget() as running:
        yield running


@pytest.fixture
async def registered(
    api_app: FastAPI,
    asgi_client: httpx.AsyncClient,
    api_settings: Settings,
    fake_target: RunningTarget,
) -> RegisteredTarget:
    return await register_fake_target(api_app, asgi_client, api_settings, fake_target)
