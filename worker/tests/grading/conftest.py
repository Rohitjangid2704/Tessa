from collections.abc import AsyncIterator

import pytest

from tessa_api.db.session import SessionFactory, create_engine, create_session_factory
from tessa_api.settings import Settings
from tessa_worker.settings import WorkerSettings
from tests.fakes.openai import FakeProvider
from tests.grading.support import FakeProviders
from tests.runs.support import RecordingIngest


@pytest.fixture
async def session_factory(api_settings: Settings, database: None) -> AsyncIterator[SessionFactory]:
    engine = create_engine(api_settings.database_url)
    yield create_session_factory(engine)
    await engine.dispose()


@pytest.fixture
def ingest() -> RecordingIngest:
    return RecordingIngest()


@pytest.fixture
def fake_provider() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
def providers(fake_provider: FakeProvider) -> FakeProviders:
    return FakeProviders(fake_provider)


@pytest.fixture
def stub_settings(worker_settings: WorkerSettings) -> WorkerSettings:
    return worker_settings.model_copy(update={"stub_models": True})
