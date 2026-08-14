import asyncio
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from temporalio import workflow
from temporalio.exceptions import (
    ActivityError,
    ApplicationError,
    ChildWorkflowError,
    FailureError,
    WorkflowAlreadyStartedError,
)

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.enums import (
        MutationOutcome,
        NotificationKind,
        RunStatus,
        Severity,
    )
    from tessa_api.schemas.notifications import NotificationContent
    from tessa_api.schemas.temporal import (
        CANCEL_SIGNAL,
        CREATE_NOTIFICATION_ACTIVITY,
        EXECUTE_RUN_WORKFLOW,
        FINALIZE_RUN_ACTIVITY,
        MUTATION_ACTIVITY_START_TO_CLOSE,
        MUTATION_RUN_WORKFLOW,
        PROGRESS_QUERY,
        SCORE_MUTATION_ACTIVITY,
        UPDATE_RUN_STATUS_ACTIVITY,
        CreateNotificationResult,
        ExecuteRunInput,
        ExecuteRunResult,
        FinalizeRunInput,
        FinalizeRunResult,
        MutationRunInput,
        MutationRunProgress,
        MutationRunResult,
        ScoreMutationInput,
        ScoreMutationResult,
        UpdateRunStatusInput,
        UpdateRunStatusResult,
        execute_run_workflow_id,
    )
    from tessa_worker.activities.mutation_models import (
        CLOSE_MUTATION_RUN,
        PREPARE_MUTATION_RUN,
        RESOLVE_BASELINE_RUN,
        VERIFY_DEPLOYED_MARKER,
        CloseMutationRunInput,
        MutationRunContext,
        PrepareMutationRunInput,
        ResolveBaselineInput,
        ResolvedBaseline,
        VerifiedMarker,
        VerifyDeployedMarkerInput,
    )
    from tessa_worker.workflows.calls import (
        call_activity,
        call_activity_without_result,
        failure_text,
    )

MutationStage = Literal["verifying_marker", "baseline", "mutant_run", "scoring", "done"]

CANCELED_REASON = "canceled by request"
ABORTED_REASON_MAX_CHARS = 500
SURVIVOR_LINK_PREFIX = "/mutation?target_id="
SURVIVED_TITLE = "Mutant {name} survived the suite"
SURVIVED_BODY = "No expected invariant caught it: {invariants}"


@dataclass(frozen=True, slots=True)
class ChildOutcome:
    result: ExecuteRunResult | None
    failure: str | None


def survivor_notification(
    context: MutationRunContext, request: MutationRunInput, scored: ScoreMutationResult
) -> NotificationContent:
    survivors = [
        item.invariant_id for item in scored.outcomes if item.outcome is MutationOutcome.survived
    ]
    return NotificationContent(
        kind=NotificationKind.mutant_survived,
        severity=Severity.high,
        title=SURVIVED_TITLE.format(name=context.mutant_name),
        body=SURVIVED_BODY.format(invariants=", ".join(survivors)),
        link=f"{SURVIVOR_LINK_PREFIX}{context.target_id}",
        run_id=request.run_id,
    )


def empty_result() -> MutationRunResult:
    return MutationRunResult(outcomes=[], power=None)


@workflow.defn(name=MUTATION_RUN_WORKFLOW)
class MutationRunWorkflow:
    def __init__(self) -> None:
        self.cancel_requested = False
        self.stage: MutationStage = "verifying_marker"
        self.baseline_run_id: UUID | None = None
        self.mutant_run_id: UUID | None = None
        self.scored: ScoreMutationResult | None = None

    @workflow.signal(name=CANCEL_SIGNAL)
    def cancel(self) -> None:
        self.cancel_requested = True

    @workflow.query(name=PROGRESS_QUERY)
    def progress(self) -> MutationRunProgress:
        return MutationRunProgress(
            stage=self.stage,
            baseline_run_id=self.baseline_run_id,
            mutant_run_id=self.mutant_run_id,
        )

    @workflow.run
    async def run(self, request: MutationRunInput) -> MutationRunResult:
        try:
            return await self.execute(request)
        except asyncio.CancelledError:
            await self.conclude(request, RunStatus.canceled, CANCELED_REASON)
            raise
        except Exception as error:
            await self.conclude(request, RunStatus.failed, failure_text(error))
            if isinstance(error, FailureError):
                raise
            raise ApplicationError(failure_text(error), non_retryable=True) from error

    async def execute(self, request: MutationRunInput) -> MutationRunResult:
        await self.set_status(request, RunStatus.planning)
        context = await call_activity(
            PREPARE_MUTATION_RUN,
            PrepareMutationRunInput(run_id=request.run_id, mutation_run_id=request.mutation_run_id),
            MutationRunContext,
            MUTATION_ACTIVITY_START_TO_CLOSE,
        )
        self.stage = "verifying_marker"
        marker = await self.verify_marker(request)
        if self.cancel_requested:
            return await self.cancel_run(request)
        if not marker.ok:
            return await self.abort(
                request,
                RunStatus.failed,
                f"the deployed marker was not found: {marker.reason}",
            )
        self.stage = "baseline"
        baseline_failure = await self.ensure_baseline(request, context)
        if self.cancel_requested:
            return await self.cancel_run(request)
        if baseline_failure is not None:
            return await self.abort(request, RunStatus.failed, baseline_failure)
        self.stage = "mutant_run"
        outcome = await self.run_mutant(request, context)
        if self.cancel_requested:
            return await self.cancel_run(request)
        if outcome.result is None or outcome.result.status is not RunStatus.completed:
            return await self.abort_after_run(request, outcome)
        self.stage = "scoring"
        scored = await self.score(request, None)
        await self.notify_survivor(request, context, scored)
        self.stage = "done"
        return await self.conclude(request, RunStatus.completed, None)

    async def verify_marker(self, request: MutationRunInput) -> VerifiedMarker:
        try:
            return await call_activity(
                VERIFY_DEPLOYED_MARKER,
                VerifyDeployedMarkerInput(mutation_run_id=request.mutation_run_id),
                VerifiedMarker,
                MUTATION_ACTIVITY_START_TO_CLOSE,
            )
        except ActivityError as error:
            return VerifiedMarker(checked=True, ok=False, reason=failure_text(error))

    async def ensure_baseline(
        self, request: MutationRunInput, context: MutationRunContext
    ) -> str | None:
        try:
            baseline = await call_activity(
                RESOLVE_BASELINE_RUN,
                ResolveBaselineInput(
                    run_id=request.run_id, mutation_run_id=request.mutation_run_id
                ),
                ResolvedBaseline,
                MUTATION_ACTIVITY_START_TO_CLOSE,
            )
        except ActivityError as error:
            return f"no baseline run could be chosen: {failure_text(error)}"
        self.baseline_run_id = baseline.baseline_run_id
        if baseline.reused:
            return None
        outcome = await self.run_child(
            ExecuteRunInput(
                run_id=baseline.baseline_run_id, max_concurrency=context.max_concurrency
            )
        )
        if outcome.result is None:
            return f"the baseline run failed: {outcome.failure}"
        if outcome.result.status is not RunStatus.completed and not self.cancel_requested:
            reason = f": {outcome.result.reason}" if outcome.result.reason else ""
            return f"the baseline run ended {outcome.result.status.value}{reason}"
        return None

    async def run_mutant(
        self, request: MutationRunInput, context: MutationRunContext
    ) -> ChildOutcome:
        self.mutant_run_id = request.run_id
        return await self.run_child(
            ExecuteRunInput(
                run_id=request.run_id, max_concurrency=context.max_concurrency, owns_run=False
            )
        )

    async def run_child(self, argument: ExecuteRunInput) -> ChildOutcome:
        try:
            handle: workflow.ChildWorkflowHandle[
                Any, ExecuteRunResult
            ] = await workflow.start_child_workflow(
                EXECUTE_RUN_WORKFLOW,
                argument,
                id=execute_run_workflow_id(argument.run_id),
                result_type=ExecuteRunResult,
                cancellation_type=workflow.ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
                parent_close_policy=workflow.ParentClosePolicy.REQUEST_CANCEL,
            )
        except (ChildWorkflowError, WorkflowAlreadyStartedError) as error:
            return ChildOutcome(result=None, failure=failure_text(error))
        await workflow.wait_condition(lambda: handle.done() or self.cancel_requested)
        if not handle.done():
            await handle.signal(CANCEL_SIGNAL)
        try:
            return ChildOutcome(result=await handle, failure=None)
        except ChildWorkflowError as error:
            return ChildOutcome(result=None, failure=failure_text(error))

    async def score(self, request: MutationRunInput, aborted: str | None) -> ScoreMutationResult:
        clipped = None if aborted is None else aborted[:ABORTED_REASON_MAX_CHARS]
        scored = await call_activity(
            SCORE_MUTATION_ACTIVITY,
            ScoreMutationInput(mutation_run_id=request.mutation_run_id, aborted_reason=clipped),
            ScoreMutationResult,
            MUTATION_ACTIVITY_START_TO_CLOSE,
        )
        self.scored = scored
        return scored

    async def notify_survivor(
        self, request: MutationRunInput, context: MutationRunContext, scored: ScoreMutationResult
    ) -> None:
        if scored.mutant_outcome is not MutationOutcome.survived:
            return
        try:
            await call_activity(
                CREATE_NOTIFICATION_ACTIVITY,
                survivor_notification(context, request, scored),
                CreateNotificationResult,
            )
        except ActivityError as error:
            workflow.logger.warning(
                "mutant_survived_not_notified", extra={"cause": failure_text(error)}
            )

    async def abort_after_run(
        self, request: MutationRunInput, outcome: ChildOutcome
    ) -> MutationRunResult:
        if outcome.result is None:
            return await self.abort(
                request, RunStatus.failed, f"the run against the mutant failed: {outcome.failure}"
            )
        status = outcome.result.status
        reason = outcome.result.reason or f"the run against the mutant ended {status.value}"
        return await self.abort(request, status, reason)

    async def abort(
        self, request: MutationRunInput, status: RunStatus, reason: str
    ) -> MutationRunResult:
        await self.score(request, reason)
        return await self.conclude(request, status, reason)

    async def cancel_run(self, request: MutationRunInput) -> MutationRunResult:
        await self.set_status(request, RunStatus.canceling)
        return await self.conclude(request, RunStatus.canceled, CANCELED_REASON)

    async def set_status(
        self, request: MutationRunInput, status: RunStatus, reason: str | None = None
    ) -> None:
        await call_activity(
            UPDATE_RUN_STATUS_ACTIVITY,
            UpdateRunStatusInput(run_id=request.run_id, status=status, reason=reason),
            UpdateRunStatusResult,
        )

    async def conclude(
        self, request: MutationRunInput, status: RunStatus, reason: str | None
    ) -> MutationRunResult:
        await call_activity(
            FINALIZE_RUN_ACTIVITY, FinalizeRunInput(run_id=request.run_id), FinalizeRunResult
        )
        await self.set_status(request, status, reason)
        await call_activity_without_result(
            CLOSE_MUTATION_RUN, CloseMutationRunInput(mutation_run_id=request.mutation_run_id)
        )
        scored = self.scored
        if scored is None:
            return empty_result()
        return MutationRunResult(outcomes=scored.outcomes, power=scored.power)
