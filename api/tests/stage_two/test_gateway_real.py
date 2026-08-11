import json
import uuid
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI
from temporalio.client import WorkflowExecutionStatus
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment

from tessa_api.schemas.temporal import (
    CANCEL_SIGNAL,
    EXECUTE_RUN_WORKFLOW,
    ExecuteRunInput,
    execute_run_workflow_id,
)
from tessa_api.temporal_client import TemporalGateway, WorkflowNotRunningError
from tests.stage_two.run_support import start_run
from tests.stage_two.support import RUNS_PATH, seed_gracie

pytestmark = pytest.mark.integration

TASK_QUEUE = "tessa-test"


@pytest.fixture
async def temporal_env() -> AsyncIterator[WorkflowEnvironment]:
    environment = await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    )
    yield environment
    await environment.shutdown()


@pytest.fixture
async def gateway(temporal_env: WorkflowEnvironment) -> TemporalGateway:
    return TemporalGateway(
        temporal_env.client.service_client.config.target_host, "default", TASK_QUEUE
    )


async def signal_names(temporal_env: WorkflowEnvironment, workflow_id: str) -> list[str]:
    handle = temporal_env.client.get_workflow_handle(workflow_id)
    return [
        event.workflow_execution_signaled_event_attributes.signal_name
        async for event in handle.fetch_history_events()
        if event.HasField("workflow_execution_signaled_event_attributes")
    ]


async def test_the_gateway_starts_execute_run_by_name_with_the_run_id_and_the_concurrency(
    gateway: TemporalGateway, temporal_env: WorkflowEnvironment
) -> None:
    run_id = uuid.uuid4()
    workflow_id = execute_run_workflow_id(run_id)
    await gateway.start_workflow(
        EXECUTE_RUN_WORKFLOW, ExecuteRunInput(run_id=run_id, max_concurrency=3), workflow_id
    )
    handle = temporal_env.client.get_workflow_handle(workflow_id)
    description = await handle.describe()
    assert description.workflow_type == "ExecuteRun"
    assert description.task_queue == TASK_QUEUE
    assert description.status == WorkflowExecutionStatus.RUNNING
    first = await anext(handle.fetch_history_events())
    payload = first.workflow_execution_started_event_attributes.input.payloads[0]
    assert json.loads(payload.data) == {
        "run_id": str(run_id),
        "max_concurrency": 3,
        "reset_seed": False,
        "owns_run": True,
    }


async def test_the_gateway_signals_cancel_to_a_running_workflow(
    gateway: TemporalGateway, temporal_env: WorkflowEnvironment
) -> None:
    run_id = uuid.uuid4()
    workflow_id = execute_run_workflow_id(run_id)
    await gateway.start_workflow(EXECUTE_RUN_WORKFLOW, ExecuteRunInput(run_id=run_id), workflow_id)
    await gateway.signal_workflow(workflow_id, CANCEL_SIGNAL)
    assert await signal_names(temporal_env, workflow_id) == ["cancel"]


async def test_signalling_a_finished_or_unknown_workflow_is_reported_as_not_running(
    gateway: TemporalGateway, temporal_env: WorkflowEnvironment
) -> None:
    run_id = uuid.uuid4()
    workflow_id = execute_run_workflow_id(run_id)
    await gateway.start_workflow(EXECUTE_RUN_WORKFLOW, ExecuteRunInput(run_id=run_id), workflow_id)
    await temporal_env.client.get_workflow_handle(workflow_id).terminate("test")
    with pytest.raises(WorkflowNotRunningError):
        await gateway.signal_workflow(workflow_id, CANCEL_SIGNAL)
    with pytest.raises(WorkflowNotRunningError):
        await gateway.signal_workflow(execute_run_workflow_id(uuid.uuid4()), CANCEL_SIGNAL)


async def test_post_runs_and_cancel_work_through_the_real_gateway(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    gateway: TemporalGateway,
    temporal_env: WorkflowEnvironment,
) -> None:
    db_app.state.temporal = gateway
    seeded = await seed_gracie(client, member_headers)
    handle = await start_run(client, member_headers, seeded)
    description = await temporal_env.client.get_workflow_handle(handle["workflow_id"]).describe()
    assert description.workflow_type == "ExecuteRun"
    assert description.status == WorkflowExecutionStatus.RUNNING
    response = await client.post(f"{RUNS_PATH}/{handle['run_id']}/cancel", headers=member_headers)
    assert response.status_code == 202
    assert await signal_names(temporal_env, handle["workflow_id"]) == ["cancel"]
    await temporal_env.client.get_workflow_handle(handle["workflow_id"]).terminate("test")
    again = await client.post(f"{RUNS_PATH}/{handle['run_id']}/cancel", headers=member_headers)
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "run_not_cancelable"


async def test_an_unreachable_temporal_fails_the_run_with_503(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    db_app.state.temporal = TemporalGateway("127.0.0.1:1", "default", TASK_QUEUE)
    seeded = await seed_gracie(client, member_headers)
    response = await client.post(
        RUNS_PATH,
        json={
            "plan": {
                "target_id": seeded.target_id,
                "saved": False,
                "selection": {
                    "feature_ids": ["smart_log.read.open_maintenance"],
                    "area_ids": [],
                    "roles": ["all"],
                    "interface_mode": "api_only",
                    "depth": "smoke",
                    "k": 1,
                },
            }
        },
        headers={**member_headers, "Idempotency-Key": "real-gateway-down"},
    )
    assert response.status_code == 503
    assert response.json()["error"]["details"][0]["code"] == "temporal"
    listed = (await client.get(RUNS_PATH, headers=member_headers)).json()["items"]
    assert [item["status"] for item in listed] == ["failed"]
