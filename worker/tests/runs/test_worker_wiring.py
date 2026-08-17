import importlib
import inspect
import pkgutil
from collections import Counter
from collections.abc import AsyncIterator, Callable, Iterator
from types import ModuleType
from typing import Any

import httpx
import pytest
from temporalio import activity, workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner

import tessa_worker
from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.services.artifact_store import InMemoryArtifactStore
from tessa_api.services.storage import LocalBundleStore
from tessa_api.settings import Settings
from tessa_worker.activities.session_queue import SessionQueue
from tessa_worker.main import (
    WorkerServices,
    build_activities,
    build_session_activities,
    build_session_worker,
    build_worker,
)
from tessa_worker.settings import WorkerSettings
from tessa_worker.workflows import WORKFLOWS
from tests.runs.drive_support import FakeOpener


def worker_modules() -> Iterator[ModuleType]:
    for module_info in pkgutil.walk_packages(tessa_worker.__path__, "tessa_worker."):
        yield importlib.import_module(module_info.name)


def own_members(module: ModuleType) -> Iterator[Any]:
    for value in vars(module).values():
        if getattr(value, "__module__", None) == module.__name__:
            yield value


def activity_names_in(member: Any) -> Iterator[str]:
    candidates = vars(member).values() if inspect.isclass(member) else [member]
    for candidate in candidates:
        if callable(candidate):
            definition = activity._Definition.from_callable(candidate)
            if definition is not None and definition.name is not None:
                yield definition.name


def defined_activity_names() -> Counter[str]:
    names: Counter[str] = Counter()
    for module in worker_modules():
        for member in own_members(module):
            names.update(activity_names_in(member))
    return names


def defined_workflow_names() -> Counter[str]:
    names: Counter[str] = Counter()
    for module in worker_modules():
        for member in own_members(module):
            if inspect.isclass(member):
                definition = workflow._Definition.from_class(member)
                if definition is not None and definition.name is not None:
                    names[definition.name] += 1
    return names


def registered_names(functions: list[Callable[..., Any]]) -> list[str]:
    names: list[str] = []
    for function in functions:
        name = activity._Definition.must_from_callable(function).name
        assert name is not None
        names.append(name)
    return names


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


def session_activity_names(services: WorkerServices) -> list[str]:
    sessions = build_session_activities(services)
    return registered_names(
        [sessions.open_browser_session, sessions.close_browser_session, sessions.execute_action]
    )


def test_every_activity_is_defined_once_in_the_worker_package() -> None:
    duplicated = {name: count for name, count in defined_activity_names().items() if count > 1}
    assert duplicated == {}


async def test_every_defined_activity_is_registered_exactly_once_on_one_of_the_two_workers(
    services: WorkerServices,
) -> None:
    main = registered_names(build_activities(services))
    session = session_activity_names(services)
    assert [name for name, count in Counter(main).items() if count > 1] == []
    assert len(session) == len(set(session))
    assert set(main).isdisjoint(session)
    assert set(main) | set(session) == set(defined_activity_names())


async def test_the_session_worker_serves_only_the_three_browser_session_activities(
    services: WorkerServices,
) -> None:
    assert set(session_activity_names(services)) == {
        "open_browser_session",
        "close_browser_session",
        "execute_action",
    }


def test_every_workflow_class_of_the_worker_package_is_registered_exactly_once() -> None:
    registered = [workflow._Definition.must_from_class(cls).name for cls in WORKFLOWS]
    assert len(registered) == len(set(registered))
    defined = defined_workflow_names()
    assert {name: count for name, count in defined.items() if count > 1} == {}
    assert set(registered) == set(defined)


@pytest.mark.parametrize("workflow_class", WORKFLOWS, ids=lambda cls: cls.__name__)
async def test_every_registered_workflow_passes_the_temporal_sandbox(workflow_class: type) -> None:
    SandboxedWorkflowRunner().prepare_workflow(workflow._Definition.must_from_class(workflow_class))


@pytest.mark.integration
async def test_both_workers_can_be_built_on_their_own_task_queues(
    temporal_env: WorkflowEnvironment, services: WorkerServices
) -> None:
    worker = build_worker(temporal_env.client, services)
    sessions = build_session_activities(services)
    session_worker = build_session_worker(temporal_env.client, services, sessions)
    assert worker.task_queue == services.settings.temporal_task_queue
    assert session_worker.task_queue == SessionQueue.for_process(services.settings).name
    assert worker.task_queue != session_worker.task_queue
    assert worker.task_queue.startswith("tessa-test")
    assert session_worker.task_queue.startswith(f"{worker.task_queue}-w-")
