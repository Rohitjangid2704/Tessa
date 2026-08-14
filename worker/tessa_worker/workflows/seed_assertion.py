from collections.abc import Callable
from typing import Any
from uuid import UUID

from temporalio import workflow
from temporalio.exceptions import ApplicationError, ChildWorkflowError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.enums import SeedAction
    from tessa_api.schemas.temporal import (
        CANCEL_SIGNAL,
        SEED_TARGET_WORKFLOW,
        SeedAssertionResult,
        SeedTargetInput,
        SeedTargetResult,
        seed_target_workflow_id,
    )
    from tessa_worker.activities.names import ASSERT_SEED, PLAN_SEED_ASSERTION
    from tessa_worker.activities.run_models import (
        SEED_UNVERIFIED_REASON,
        AssertSeedInput,
        SeedAssertionPlan,
        SettleSeedAssertionInput,
    )
    from tessa_worker.truth.errors import SeedFailureCode
    from tessa_worker.workflows.calls import call_activity, failure_text

SEED_CANCELED_REASON = "canceled by request"


def unverified_assertion(reason: str) -> SeedAssertionResult:
    return SeedAssertionResult(
        outcome="unverified", seed_hash=None, observed_hash=None, expected_hash=None, reason=reason
    )


def failed_assertion(reason: str) -> SeedAssertionResult:
    return SeedAssertionResult(
        outcome="failed", seed_hash=None, observed_hash=None, expected_hash=None, reason=reason
    )


def failed_child(
    run_id: UUID, action: SeedAction, error: ChildWorkflowError
) -> SettleSeedAssertionInput | None:
    cause = error.cause
    if not isinstance(cause, ApplicationError):
        return SettleSeedAssertionInput(
            run_id=run_id, action=action, failure_message=failure_text(error)
        )
    if cause.type == SeedFailureCode.canceled.value:
        return None
    return SettleSeedAssertionInput(
        run_id=run_id, action=action, failure_code=cause.type, failure_message=cause.message
    )


async def run_seed_target(
    run_id: UUID,
    target_id: UUID,
    seed_id: UUID,
    action: SeedAction,
    cancel_requested: Callable[[], bool],
) -> SettleSeedAssertionInput | None:
    handle: workflow.ChildWorkflowHandle[
        Any, SeedTargetResult
    ] = await workflow.start_child_workflow(
        SEED_TARGET_WORKFLOW,
        SeedTargetInput(run_id=run_id, target_id=target_id, seed_id=seed_id, action=action),
        id=seed_target_workflow_id(run_id),
        result_type=SeedTargetResult,
        cancellation_type=workflow.ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
        parent_close_policy=workflow.ParentClosePolicy.REQUEST_CANCEL,
    )
    await workflow.wait_condition(lambda: handle.done() or cancel_requested())
    if not handle.done():
        await handle.signal(CANCEL_SIGNAL)
    try:
        result = await handle
    except ChildWorkflowError as error:
        return failed_child(run_id, action, error)
    return SettleSeedAssertionInput(run_id=run_id, action=action, result=result)


async def assert_run_seed(
    run_id: UUID, reset_seed: bool, cancel_requested: Callable[[], bool]
) -> SeedAssertionResult:
    plan = await call_activity(
        PLAN_SEED_ASSERTION,
        AssertSeedInput(run_id=run_id, reset_seed=reset_seed),
        SeedAssertionPlan,
    )
    if plan.failure_reason is not None:
        return failed_assertion(plan.failure_reason)
    if plan.target_id is None or plan.seed_id is None or plan.action is None:
        return unverified_assertion(plan.unverified_reason or SEED_UNVERIFIED_REASON)
    settled = await run_seed_target(
        run_id, plan.target_id, plan.seed_id, plan.action, cancel_requested
    )
    if settled is None:
        return failed_assertion(SEED_CANCELED_REASON)
    return await call_activity(ASSERT_SEED, settled, SeedAssertionResult)
