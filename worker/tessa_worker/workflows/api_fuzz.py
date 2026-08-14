from collections.abc import Callable
from typing import Any
from uuid import UUID

from temporalio import workflow
from temporalio.exceptions import ActivityError, ChildWorkflowError, WorkflowAlreadyStartedError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.enums import SkipReason
    from tessa_api.schemas.temporal import (
        CANCEL_SIGNAL,
        FUZZ_FAMILY_WORKFLOW,
        FuzzFamilyInput,
        FuzzFamilyResult,
        fuzz_family_workflow_id,
    )
    from tessa_worker.activities.names import SKIP_RUN_SCENARIOS
    from tessa_worker.activities.run_models import (
        SkipRunScenariosInput,
        SkipRunScenariosResult,
    )
    from tessa_worker.workflows.calls import call_activity, failure_text

API_FUZZ_FAILED = "api fuzz failed"
API_FUZZ_LEFTOVERS = "api fuzz left scenarios queued and they could not be closed"


async def close_leftover_scenarios(run_id: UUID) -> str | None:
    try:
        await call_activity(
            SKIP_RUN_SCENARIOS,
            SkipRunScenariosInput(run_id=run_id, reason=SkipReason.precondition_failed),
            SkipRunScenariosResult,
        )
    except ActivityError as error:
        return f"{API_FUZZ_LEFTOVERS}: {failure_text(error)}"
    return None


async def start_fuzz_family(
    run_id: UUID,
) -> workflow.ChildWorkflowHandle[Any, FuzzFamilyResult]:
    handle: workflow.ChildWorkflowHandle[
        Any, FuzzFamilyResult
    ] = await workflow.start_child_workflow(
        FUZZ_FAMILY_WORKFLOW,
        FuzzFamilyInput(run_id=run_id),
        id=fuzz_family_workflow_id(run_id),
        result_type=FuzzFamilyResult,
        cancellation_type=workflow.ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
        parent_close_policy=workflow.ParentClosePolicy.REQUEST_CANCEL,
    )
    return handle


async def run_api_fuzz(run_id: UUID, cancel_requested: Callable[[], bool]) -> list[str]:
    try:
        handle = await start_fuzz_family(run_id)
        await workflow.wait_condition(lambda: handle.done() or cancel_requested())
        if not handle.done():
            await handle.signal(CANCEL_SIGNAL)
        result = await handle
    except (ChildWorkflowError, WorkflowAlreadyStartedError) as error:
        notices = [f"{API_FUZZ_FAILED}: {failure_text(error)}"]
        leftover = await close_leftover_scenarios(run_id)
        return notices if leftover is None else [*notices, leftover]
    return [] if result.notice is None else [result.notice]
