import asyncio
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import NoReturn

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError
from temporalio.exceptions import TimeoutError as ActivityTimeoutError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.enums import (
        RunStatus,
        SeedAction,
        SeedPhase,
        SeedPhaseStatus,
        SeedResetStatus,
    )
    from tessa_api.schemas.streams import SeedProgressPayload
    from tessa_api.schemas.temporal import (
        CANCEL_SIGNAL,
        EXECUTE_RESET_SCRIPT_ACTIVITY,
        LOAD_SEED_MATERIAL_ACTIVITY,
        PROGRESS_QUERY,
        RUN_HASH_COMMAND_ACTIVITY,
        SEED_SCRIPT_MAX_ATTEMPTS,
        SEED_SCRIPT_START_TO_CLOSE_MARGIN,
        SEED_TARGET_WORKFLOW,
        UPDATE_RUN_STATUS_ACTIVITY,
        ExecuteResetScriptInput,
        ExecuteResetScriptResult,
        LoadSeedMaterialInput,
        LoadSeedMaterialResult,
        RunHashCommandInput,
        RunHashCommandResult,
        SeedTargetInput,
        SeedTargetProgress,
        SeedTargetResult,
        UpdateRunStatusInput,
        UpdateRunStatusResult,
    )
    from tessa_worker.activities.names import OPEN_SEED_RUN, RECORD_SEED_OUTCOME
    from tessa_worker.activities.seeding_models import (
        OpenSeedRunInput,
        OpenSeedRunResult,
        RecordSeedOutcomeInput,
        RecordSeedOutcomeResult,
    )
    from tessa_worker.events import emit_event
    from tessa_worker.truth.errors import SeedFailureCode
    from tessa_worker.workflows.calls import call_activity, failure_text

SEED_HEARTBEAT_TIMEOUT = timedelta(seconds=30)
REASON_LIMIT = 500
CANCELED_REASON = "canceled by request"
ACTIVITY_FAILED_CODE = "activity_failed"
NO_HASH_COMMAND_REASON = (
    "the reset script finished; the seed has no hash command, so the state was not verified"
)
BASELINE_MISSING_MESSAGE = (
    "the seed has no expected hash yet; reset it first so the first hash is recorded"
)


class SeedStepFailure(Exception):
    def __init__(self, code: str, message: str, observed_hash: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.observed_hash = observed_hash

    @property
    def reason(self) -> str:
        return f"{self.code}: {self.message}"[:REASON_LIMIT]


def failure_from_activity(error: ActivityError) -> SeedStepFailure:
    cause = error.cause
    if isinstance(cause, ApplicationError):
        return SeedStepFailure(cause.type or SeedFailureCode.script_failed.value, cause.message)
    if isinstance(cause, ActivityTimeoutError):
        return SeedStepFailure(
            SeedFailureCode.timeout.value, "the script exceeded the seed script timeout"
        )
    return SeedStepFailure(SeedFailureCode.script_failed.value, failure_text(error))


@workflow.defn(name=SEED_TARGET_WORKFLOW)
class SeedTargetWorkflow:
    def __init__(self) -> None:
        self.cancel_requested = False
        self.owns_run = False
        self.current = SeedTargetProgress(phase=SeedPhase.reset, status=SeedPhaseStatus.started)

    @workflow.signal(name=CANCEL_SIGNAL)
    def cancel(self, reason: str | None = None) -> None:
        self.cancel_requested = True

    @workflow.query(name=PROGRESS_QUERY)
    def progress(self) -> SeedTargetProgress:
        return self.current

    @workflow.run
    async def run(self, request: SeedTargetInput) -> SeedTargetResult:
        work = asyncio.create_task(self.execute(request))
        try:
            await workflow.wait_condition(lambda: work.done() or self.cancel_requested)
        except asyncio.CancelledError:
            await self.abandon(work, request)
            raise
        if not work.done():
            await self.abandon(work, request)
            raise ApplicationError(
                CANCELED_REASON, type=SeedFailureCode.canceled.value, non_retryable=True
            )
        return work.result()

    async def abandon(self, work: asyncio.Task[SeedTargetResult], request: SeedTargetInput) -> None:
        work.cancel()
        await asyncio.gather(work, return_exceptions=True)
        if request.action is SeedAction.reset:
            await self.record(request, SeedResetStatus.failed, None, False)
        if self.owns_run:
            await self.set_status(request, RunStatus.canceling, None)
            await self.set_status(request, RunStatus.canceled, CANCELED_REASON)

    async def execute(self, request: SeedTargetInput) -> SeedTargetResult:
        first_phase = SeedPhase.reset if request.action is SeedAction.reset else SeedPhase.hash
        self.current = SeedTargetProgress(phase=first_phase, status=SeedPhaseStatus.started)
        opened = await call_activity(
            OPEN_SEED_RUN,
            OpenSeedRunInput(run_id=request.run_id, seed_id=request.seed_id),
            OpenSeedRunResult,
        )
        self.owns_run = opened.owns_run
        material = await call_activity(
            LOAD_SEED_MATERIAL_ACTIVITY,
            LoadSeedMaterialInput(seed_id=request.seed_id),
            LoadSeedMaterialResult,
        )
        await self.set_status(request, RunStatus.running, None)
        try:
            return await self.perform(request, opened, material)
        except SeedStepFailure as failure:
            await self.fail(request, failure)
        except ActivityError as error:
            await self.fail(request, SeedStepFailure(ACTIVITY_FAILED_CODE, failure_text(error)))

    async def fail(self, request: SeedTargetInput, failure: SeedStepFailure) -> NoReturn:
        try:
            await self.record(request, SeedResetStatus.failed, failure.observed_hash, False)
        except ActivityError as error:
            workflow.logger.warning(
                "seed_outcome_not_recorded", extra={"cause": failure_text(error)}
            )
        await self.finish(request, RunStatus.failed, failure.reason)
        raise ApplicationError(failure.reason, type=failure.code, non_retryable=True)

    async def perform(
        self,
        request: SeedTargetInput,
        opened: OpenSeedRunResult,
        material: LoadSeedMaterialResult,
    ) -> SeedTargetResult:
        if request.action is SeedAction.reset:
            if material.reset_script_ref is None:
                raise SeedStepFailure(
                    SeedFailureCode.hook_missing.value, "the seed has no reset script"
                )
            await self.reset_phase(request, material)
        if material.hash_command_ref is None:
            if request.action is SeedAction.verify:
                raise SeedStepFailure(
                    SeedFailureCode.hook_missing.value, "the seed has no hash command"
                )
            return await self.complete_without_hash(request, opened)
        observed = await self.hash_phase(request, material)
        return await self.assert_phase(request, opened, observed)

    async def reset_phase(self, request: SeedTargetInput, material: LoadSeedMaterialResult) -> None:
        async def reset() -> None:
            result = await self.run_script(
                EXECUTE_RESET_SCRIPT_ACTIVITY,
                ExecuteResetScriptInput(run_id=request.run_id, seed_id=request.seed_id),
                ExecuteResetScriptResult,
                material,
            )
            if result.exit_code != 0:
                raise SeedStepFailure(
                    SeedFailureCode.script_failed.value,
                    f"the reset script exited with code {result.exit_code}: "
                    f"{result.output_excerpt}",
                )

        await self.guarded_phase(request, SeedPhase.reset, reset)
        await self.announce(request, SeedPhase.reset, SeedPhaseStatus.ok, None, None)

    async def hash_phase(self, request: SeedTargetInput, material: LoadSeedMaterialResult) -> str:
        async def hash_state() -> str:
            result = await self.run_script(
                RUN_HASH_COMMAND_ACTIVITY,
                RunHashCommandInput(seed_id=request.seed_id),
                RunHashCommandResult,
                material,
            )
            return result.observed_hash

        observed = await self.guarded_phase(request, SeedPhase.hash, hash_state)
        await self.announce(request, SeedPhase.hash, SeedPhaseStatus.ok, observed, None)
        return observed

    async def assert_phase(
        self, request: SeedTargetInput, opened: OpenSeedRunResult, observed: str
    ) -> SeedTargetResult:
        declared = opened.declared_hash
        if declared is None:
            return await self.record_baseline(request, observed)
        await self.announce(request, SeedPhase.assert_, SeedPhaseStatus.started, observed, declared)
        if observed != declared:
            await self.announce(
                request, SeedPhase.assert_, SeedPhaseStatus.failed, observed, declared
            )
            await self.record(request, SeedResetStatus.mismatch, observed, False)
            await self.finish(
                request,
                RunStatus.failed,
                f"seed mismatch: the target data differs from the seed "
                f"(observed {observed}, expected {declared})"[:REASON_LIMIT],
            )
            return SeedTargetResult(matched=False, observed_hash=observed, expected_hash=declared)
        await self.announce(request, SeedPhase.assert_, SeedPhaseStatus.ok, observed, declared)
        await self.record(request, SeedResetStatus.ok, observed, False)
        await self.finish(request, RunStatus.completed, None)
        return SeedTargetResult(matched=True, observed_hash=observed, expected_hash=declared)

    async def record_baseline(self, request: SeedTargetInput, observed: str) -> SeedTargetResult:
        if request.action is SeedAction.verify:
            await self.announce(request, SeedPhase.assert_, SeedPhaseStatus.failed, observed, None)
            raise SeedStepFailure(
                SeedFailureCode.baseline_missing.value, BASELINE_MISSING_MESSAGE, observed
            )
        await self.announce(request, SeedPhase.assert_, SeedPhaseStatus.ok, observed, None)
        await self.record(request, SeedResetStatus.ok, observed, True)
        await self.finish(request, RunStatus.completed, None)
        return SeedTargetResult(matched=True, observed_hash=observed, expected_hash=None)

    async def complete_without_hash(
        self, request: SeedTargetInput, opened: OpenSeedRunResult
    ) -> SeedTargetResult:
        await self.record(request, SeedResetStatus.ok, None, False)
        await self.finish(request, RunStatus.completed, NO_HASH_COMMAND_REASON)
        return SeedTargetResult(
            matched=True, observed_hash=None, expected_hash=opened.declared_hash
        )

    async def guarded_phase[ResultT](
        self,
        request: SeedTargetInput,
        phase: SeedPhase,
        call: Callable[[], Awaitable[ResultT]],
    ) -> ResultT:
        await self.announce(request, phase, SeedPhaseStatus.started, None, None)
        try:
            return await call()
        except SeedStepFailure:
            await self.announce(request, phase, SeedPhaseStatus.failed, None, None)
            raise

    async def run_script[ResultT](
        self,
        activity_name: str,
        argument: ExecuteResetScriptInput | RunHashCommandInput,
        result_type: type[ResultT],
        material: LoadSeedMaterialResult,
    ) -> ResultT:
        try:
            result: ResultT = await workflow.execute_activity(
                activity_name,
                argument,
                result_type=result_type,
                start_to_close_timeout=timedelta(seconds=material.script_timeout_seconds)
                + SEED_SCRIPT_START_TO_CLOSE_MARGIN,
                heartbeat_timeout=SEED_HEARTBEAT_TIMEOUT,
                retry_policy=RetryPolicy(maximum_attempts=SEED_SCRIPT_MAX_ATTEMPTS),
                cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
            )
        except ActivityError as error:
            raise failure_from_activity(error) from None
        return result

    async def announce(
        self,
        request: SeedTargetInput,
        phase: SeedPhase,
        status: SeedPhaseStatus,
        observed_hash: str | None,
        expected_hash: str | None,
    ) -> None:
        self.current = SeedTargetProgress(phase=phase, status=status)
        payload = SeedProgressPayload(
            phase=phase, status=status, observed_hash=observed_hash, expected_hash=expected_hash
        )
        await emit_event(
            request.run_id,
            "seed.progress",
            payload.model_dump(mode="json"),
            f"seed.progress:{request.action.value}:{phase.value}:{status.value}",
        )

    async def record(
        self,
        request: SeedTargetInput,
        status: SeedResetStatus,
        observed_hash: str | None,
        pin_first_reset: bool,
    ) -> None:
        await call_activity(
            RECORD_SEED_OUTCOME,
            RecordSeedOutcomeInput(
                run_id=request.run_id,
                seed_id=request.seed_id,
                status=status,
                observed_hash=observed_hash,
                pin_first_reset=pin_first_reset,
            ),
            RecordSeedOutcomeResult,
        )

    async def finish(self, request: SeedTargetInput, status: RunStatus, reason: str | None) -> None:
        await self.set_status(request, status, reason)

    async def set_status(
        self, request: SeedTargetInput, status: RunStatus, reason: str | None
    ) -> None:
        if not self.owns_run:
            return
        await call_activity(
            UPDATE_RUN_STATUS_ACTIVITY,
            UpdateRunStatusInput(run_id=request.run_id, status=status, reason=reason),
            UpdateRunStatusResult,
        )
