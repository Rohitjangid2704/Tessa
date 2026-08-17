import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from temporalio import activity
from temporalio.client import WorkflowHandle
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from tessa_api.schemas.hello import (
    EmitRunEventInput,
    EmitRunEventResult,
    HelloWorkflowInput,
    HelloWorkflowResult,
    LayaSmokeInput,
    LayaSmokeResult,
)
from tessa_api.services.hello import HELLO_WORKFLOW_NAME
from tessa_worker.activities.names import EMIT_RUN_EVENT, LAYA_SMOKE_CALL
from tessa_worker.workflows import WORKFLOWS

TASK_QUEUE = "tessa-test"
POLL_SECONDS = 0.02
POLL_ATTEMPTS = 500


@dataclass
class RecordedEvent:
    type: str
    dedupe_key: str | None
    payload: dict[str, Any]


@dataclass
class StubEmitter:
    events: list[RecordedEvent] = field(default_factory=list)
    attempts: int = 0
    failing_types: frozenset[str] = frozenset()

    @activity.defn(name=EMIT_RUN_EVENT)
    async def emit_run_event(self, request: EmitRunEventInput) -> EmitRunEventResult:
        self.attempts += 1
        if request.type in self.failing_types:
            raise RuntimeError("ingest is down")
        self.events.append(RecordedEvent(request.type, request.dedupe_key, request.payload))
        return EmitRunEventResult(seq=len(self.events))

    @property
    def types(self) -> list[str]:
        return [event.type for event in self.events]

    @property
    def dedupe_keys(self) -> list[str | None]:
        return [event.dedupe_key for event in self.events]

    def payloads(self, event_type: str) -> list[dict[str, Any]]:
        return [event.payload for event in self.events if event.type == event_type]


@dataclass
class StubLaya:
    result: LayaSmokeResult | None = None
    failure: Exception | None = None
    calls: list[str] = field(default_factory=list)

    @activity.defn(name=LAYA_SMOKE_CALL)
    async def laya_smoke_call(self, request: LayaSmokeInput) -> LayaSmokeResult:
        self.calls.append(request.text)
        if self.failure is not None:
            raise self.failure
        if self.result is not None:
            return self.result
        return LayaSmokeResult(ok=True, latency_ms=12, status_code=200, response_excerpt="noul=0.9")


def hello_input(
    ticks: int = 5, tick_interval_ms: int = 1000, include_laya: bool = True
) -> HelloWorkflowInput:
    return HelloWorkflowInput(
        run_id=uuid4(),
        ticks=ticks,
        tick_interval_ms=tick_interval_ms,
        include_laya=include_laya,
    )


@asynccontextmanager
async def running_worker(
    environment: WorkflowEnvironment, activities: Sequence[Any]
) -> AsyncIterator[None]:
    async with Worker(
        environment.client,
        task_queue=TASK_QUEUE,
        workflows=WORKFLOWS,
        activities=activities,
    ):
        yield


async def start_hello(
    environment: WorkflowEnvironment, request: HelloWorkflowInput
) -> WorkflowHandle[Any, HelloWorkflowResult]:
    return await environment.client.start_workflow(
        HELLO_WORKFLOW_NAME,
        request,
        id=f"hello-{request.run_id}",
        task_queue=TASK_QUEUE,
        result_type=HelloWorkflowResult,
    )


async def run_hello(
    environment: WorkflowEnvironment, request: HelloWorkflowInput
) -> HelloWorkflowResult:
    handle = await start_hello(environment, request)
    return await handle.result()


async def wait_until(predicate: Callable[[], Awaitable[bool]]) -> None:
    for _ in range(POLL_ATTEMPTS):
        if await predicate():
            return
        await asyncio.sleep(POLL_SECONDS)
    raise AssertionError("condition did not become true in time")
