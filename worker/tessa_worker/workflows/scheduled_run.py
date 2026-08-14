from datetime import timedelta
from uuid import UUID

from temporalio import workflow
from temporalio.exceptions import (
    ActivityError,
    ApplicationError,
    CancelledError,
    ChildWorkflowError,
)

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.enums import NotificationKind, RunStatus, Severity
    from tessa_api.schemas.schedules import ScheduledRunStart, ScheduledRunStarted
    from tessa_api.schemas.temporal import (
        CREATE_NOTIFICATION_ACTIVITY,
        EXECUTE_RUN_WORKFLOW,
        FINALIZE_RUN_ACTIVITY,
        SCHEDULED_RUN_WORKFLOW,
        UPDATE_RUN_STATUS_ACTIVITY,
        CreateNotificationInput,
        CreateNotificationResult,
        ExecuteRunInput,
        ExecuteRunResult,
        FinalizeRunInput,
        FinalizeRunResult,
        ScheduledRunInput,
        ScheduledRunResult,
        UpdateRunStatusInput,
        UpdateRunStatusResult,
        execute_run_workflow_id,
    )
    from tessa_worker.activities.schedule_run_models import (
        CREATE_SCHEDULED_RUN,
        LOAD_SCHEDULED_RUN_OUTCOME,
        ScheduledRunOutcome,
        ScheduledRunOutcomeInput,
    )
    from tessa_worker.workflows.calls import call_activity, failure_text

CREATE_RUN_START_TO_CLOSE = timedelta(seconds=60)
SCHEDULES_LINK = "/catalog?tab=plans"
NOT_CREATED_TITLE = "A scheduled run could not be created"
NOT_FINISHED_TITLE = "A scheduled run did not finish cleanly"


@workflow.defn(name=SCHEDULED_RUN_WORKFLOW)
class ScheduledRunWorkflow:
    @workflow.run
    async def run(self, request: ScheduledRunInput) -> ScheduledRunResult:
        run_id = request.run_id
        if run_id is None:
            run_id = workflow.uuid4()
            await self.create_run(request.schedule_id, run_id)
        return await self.execute(request.schedule_id, run_id)

    async def create_run(self, schedule_id: UUID, run_id: UUID) -> None:
        try:
            await call_activity(
                CREATE_SCHEDULED_RUN,
                ScheduledRunStart(schedule_id=schedule_id, run_id=run_id),
                ScheduledRunStarted,
                CREATE_RUN_START_TO_CLOSE,
            )
        except ActivityError as error:
            reason = failure_text(error)
            await self.announce(schedule_id, None, NOT_CREATED_TITLE, reason)
            raise ApplicationError(
                f"the scheduled run was not created: {reason}", non_retryable=True
            ) from error

    async def execute(self, schedule_id: UUID, run_id: UUID) -> ScheduledRunResult:
        try:
            result = await workflow.execute_child_workflow(
                EXECUTE_RUN_WORKFLOW,
                ExecuteRunInput(run_id=run_id),
                id=execute_run_workflow_id(run_id),
                result_type=ExecuteRunResult,
                parent_close_policy=workflow.ParentClosePolicy.REQUEST_CANCEL,
            )
        except ChildWorkflowError as error:
            return await self.settle_after_failure(schedule_id, run_id, error)
        return ScheduledRunResult(run_id=run_id, status=result.status, counters=result.counters)

    async def load_outcome(self, run_id: UUID) -> ScheduledRunOutcome:
        return await call_activity(
            LOAD_SCHEDULED_RUN_OUTCOME, ScheduledRunOutcomeInput(run_id=run_id), ScheduledRunOutcome
        )

    async def settle_after_failure(
        self, schedule_id: UUID, run_id: UUID, error: ChildWorkflowError
    ) -> ScheduledRunResult:
        reason = failure_text(error)
        outcome = await self.load_outcome(run_id)
        if not outcome.terminal:
            await self.close_run(run_id, reason)
            outcome = await self.load_outcome(run_id)
        if not isinstance(error.cause, CancelledError):
            await self.announce(schedule_id, run_id, NOT_FINISHED_TITLE, reason)
        return ScheduledRunResult(run_id=run_id, status=outcome.status, counters=outcome.counters)

    async def close_run(self, run_id: UUID, reason: str) -> None:
        await call_activity(
            FINALIZE_RUN_ACTIVITY, FinalizeRunInput(run_id=run_id), FinalizeRunResult
        )
        await call_activity(
            UPDATE_RUN_STATUS_ACTIVITY,
            UpdateRunStatusInput(run_id=run_id, status=RunStatus.failed, reason=reason),
            UpdateRunStatusResult,
        )

    async def announce(
        self, schedule_id: UUID, run_id: UUID | None, title: str, reason: str
    ) -> None:
        content = CreateNotificationInput(
            kind=NotificationKind.schedule_failed,
            severity=Severity.high,
            title=title,
            body=f"Schedule {schedule_id}: {reason}",
            link=SCHEDULES_LINK if run_id is None else f"/runs/{run_id}",
            run_id=run_id,
        )
        await self.deliver(content)

    async def deliver(self, content: CreateNotificationInput) -> None:
        try:
            await call_activity(CREATE_NOTIFICATION_ACTIVITY, content, CreateNotificationResult)
        except ActivityError as error:
            workflow.logger.warning(
                "schedule_failure_not_announced", extra={"cause": failure_text(error)}
            )
