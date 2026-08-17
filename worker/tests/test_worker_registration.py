from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any

import httpx
import pytest
from temporalio import activity, workflow
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner

from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.schemas.temporal import (
    CLOSE_BROWSER_SESSION_ACTIVITY,
    EXECUTE_ACTION_ACTIVITY,
    OPEN_BROWSER_SESSION_ACTIVITY,
)
from tessa_api.services.artifact_store import InMemoryArtifactStore
from tessa_api.services.storage import LocalBundleStore
from tessa_api.settings import Settings
from tessa_worker.main import WorkerServices, build_activities, build_session_activities
from tessa_worker.settings import WorkerSettings
from tessa_worker.workflows import WORKFLOWS
from tests.runs.drive_support import FakeOpener

SESSION_ACTIVITIES = {
    OPEN_BROWSER_SESSION_ACTIVITY,
    CLOSE_BROWSER_SESSION_ACTIVITY,
    EXECUTE_ACTION_ACTIVITY,
}
REMOVED_WORKFLOWS = {
    "ExploreTarget",
    "SimulateSession",
    "RedTeamRun",
    "ReplayProduction",
    "ContractCheck",
    "ImportBundleFromGit",
    "FitCalibration",
    "ProbeTrafficBatch",
}


@pytest.fixture
async def services(
    worker_settings: WorkerSettings, api_settings: Settings
) -> AsyncIterator[WorkerServices]:
    engine = create_engine(api_settings.database_url)
    async with httpx.AsyncClient() as api_http, httpx.AsyncClient() as laya_http:
        yield WorkerServices(
            settings=worker_settings,
            api_http=api_http,
            laya_http=laya_http,
            session_factory=create_session_factory(engine),
            adapters=FakeOpener(),
            artifacts=InMemoryArtifactStore(),
            bundles=LocalBundleStore(api_settings.data_dir),
        )
    await engine.dispose()


def activity_names(functions: Sequence[Callable[..., Any]]) -> list[str]:
    names = [activity._Definition.must_from_callable(function).name for function in functions]
    return [name for name in names if name is not None]


async def test_every_activity_is_registered_once_across_the_shared_and_session_workers(
    services: WorkerServices,
) -> None:
    shared = activity_names(build_activities(services))
    sessions = build_session_activities(services)
    session = activity_names(
        [sessions.open_browser_session, sessions.close_browser_session, sessions.execute_action]
    )
    every = [*shared, *session]
    assert len(every) == len(set(every)) == len(build_activities(services)) + 3
    assert set(session) == SESSION_ACTIVITIES
    assert not SESSION_ACTIVITIES & set(shared)


async def test_every_workflow_passes_the_temporal_sandbox() -> None:
    runner = SandboxedWorkflowRunner()
    names = []
    for workflow_class in WORKFLOWS:
        definition = workflow._Definition.must_from_class(workflow_class)
        runner.prepare_workflow(definition)
        names.append(definition.name)
    assert len(names) == len(set(names))
    assert not REMOVED_WORKFLOWS & set(names)
