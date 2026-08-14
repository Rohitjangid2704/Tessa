from datetime import datetime, timedelta

from pydantic import BaseModel
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.retention import (
        RetentionCutoffs,
        RetentionSweepCounts,
        RetentionSweepResult,
    )
    from tessa_api.schemas.temporal import (
        RETENTION_SWEEP_WORKFLOW,
        RetentionSweepInput,
        RetentionSweepOutput,
    )
    from tessa_worker.activities.retention_models import (
        LOAD_RETENTION_PLAN,
        PURGE_ARTIFACTS,
        PURGE_RUN_EVENTS,
        PURGE_STEP_PAYLOADS,
        RECORD_RETENTION_SWEEP,
        RETENTION_ACTIVITY_MAX_ATTEMPTS,
        RETENTION_BATCH_START_TO_CLOSE,
        RETENTION_HEARTBEAT_TIMEOUT,
        RETENTION_MAX_CALLS_PER_PHASE,
        RETENTION_PLAN_START_TO_CLOSE,
        PurgeArtifactsInput,
        PurgeArtifactsResult,
        PurgeBatchInput,
        PurgeBatchResult,
    )
    from tessa_worker.workflows.calls import failure_text

RETENTION_RETRY_POLICY = RetryPolicy(
    initial_interval=timedelta(seconds=5),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(minutes=1),
    maximum_attempts=RETENTION_ACTIVITY_MAX_ATTEMPTS,
)
STEPS_PHASE = "steps"
ARTIFACTS_PHASE = "artifacts"
RUN_EVENTS_PHASE = "run_events"
RECORD_PHASE = "record"


@workflow.defn(name=RETENTION_SWEEP_WORKFLOW)
class RetentionSweepWorkflow:
    def __init__(self) -> None:
        self.failed_phases: list[str] = []

    @workflow.run
    async def run(self, request: RetentionSweepInput) -> RetentionSweepOutput:
        cutoffs: RetentionCutoffs = await workflow.execute_activity(
            LOAD_RETENTION_PLAN,
            result_type=RetentionCutoffs,
            start_to_close_timeout=RETENTION_PLAN_START_TO_CLOSE,
            retry_policy=RETENTION_RETRY_POLICY,
        )
        counts = RetentionSweepCounts(
            deleted_steps=await self.purge_in_batches(
                STEPS_PHASE, PURGE_STEP_PAYLOADS, cutoffs.steps_before
            ),
            deleted_artifacts=await self.purge_artifacts(cutoffs.artifacts_before),
            deleted_events=await self.purge_in_batches(
                RUN_EVENTS_PHASE, PURGE_RUN_EVENTS, cutoffs.run_events_before
            ),
        )
        await self.record(counts)
        if self.failed_phases:
            raise ApplicationError(
                f"retention phases failed: {', '.join(self.failed_phases)}", non_retryable=True
            )
        return RetentionSweepOutput(**counts.model_dump())

    async def call_batch[ResultT](
        self, name: str, argument: BaseModel, result_type: type[ResultT]
    ) -> ResultT:
        result: ResultT = await workflow.execute_activity(
            name,
            argument,
            result_type=result_type,
            start_to_close_timeout=RETENTION_BATCH_START_TO_CLOSE,
            heartbeat_timeout=RETENTION_HEARTBEAT_TIMEOUT,
            retry_policy=RETENTION_RETRY_POLICY,
        )
        return result

    async def purge_in_batches(self, phase: str, activity_name: str, before: datetime) -> int:
        purged = 0
        try:
            for _ in range(RETENTION_MAX_CALLS_PER_PHASE):
                result = await self.call_batch(
                    activity_name, PurgeBatchInput(before=before), PurgeBatchResult
                )
                purged += result.purged
                if not result.more:
                    break
            else:
                workflow.logger.info("retention_phase_capped", extra={"phase": phase})
        except ActivityError as error:
            self.fail(phase, error)
        return purged

    async def purge_artifacts(self, before: datetime) -> int:
        deleted = 0
        after: str | None = None
        try:
            for _ in range(RETENTION_MAX_CALLS_PER_PHASE):
                result = await self.call_batch(
                    PURGE_ARTIFACTS,
                    PurgeArtifactsInput(before=before, after=after),
                    PurgeArtifactsResult,
                )
                deleted += result.deleted
                after = result.after
                if not result.more:
                    break
            else:
                workflow.logger.info("retention_phase_capped", extra={"phase": ARTIFACTS_PHASE})
        except ActivityError as error:
            self.fail(ARTIFACTS_PHASE, error)
        return deleted

    async def record(self, counts: RetentionSweepCounts) -> None:
        try:
            await workflow.execute_activity(
                RECORD_RETENTION_SWEEP,
                counts,
                result_type=RetentionSweepResult,
                start_to_close_timeout=RETENTION_PLAN_START_TO_CLOSE,
                retry_policy=RETENTION_RETRY_POLICY,
            )
        except ActivityError as error:
            self.fail(RECORD_PHASE, error)

    def fail(self, phase: str, error: ActivityError) -> None:
        self.failed_phases.append(phase)
        workflow.logger.warning(
            "retention_phase_failed", extra={"phase": phase, "cause": failure_text(error)}
        )


__all__ = ["RetentionSweepWorkflow"]
