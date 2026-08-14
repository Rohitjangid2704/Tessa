import asyncio
from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, CancelledError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.common import Verdict
    from tessa_api.schemas.enums import RunScenarioStatus, SkipReason
    from tessa_api.schemas.temporal import (
        CANCEL_SIGNAL,
        FUZZ_FAMILY_WORKFLOW,
        FUZZ_HEARTBEAT_TIMEOUT,
        FUZZ_MAX_ATTEMPTS,
        FUZZ_START_TO_CLOSE_MARGIN,
        PREPARE_FUZZ_FAMILY_ACTIVITY,
        RUN_SCHEMATHESIS_ACTIVITY,
        FuzzFamilyInput,
        FuzzFamilyResult,
        FuzzRoleTarget,
        PrepareFuzzFamilyInput,
        PrepareFuzzFamilyResult,
        RunSchemathesisInput,
        RunSchemathesisResult,
    )
    from tessa_worker.activities.names import (
        BEGIN_SCENARIO_ATTEMPT,
        FINISH_RUN_SCENARIO,
        RECORD_SCENARIO_ATTEMPT,
    )
    from tessa_worker.activities.run_models import (
        BeginScenarioAttemptInput,
        FinishRunScenarioInput,
        RecordScenarioAttemptInput,
    )
    from tessa_worker.verdicts import (
        ATTEMPT_ERRORED,
        TIER0_FAILED,
        fail_verdict,
        pass_verdict,
        skipped_verdict,
        uncertain_verdict,
    )
    from tessa_worker.workflows.calls import (
        call_activity,
        call_activity_without_result,
        failure_text,
    )

ATTEMPT = 0
FUZZ_INCOMPLETE = "fuzz_incomplete"
FUZZ_RETRY_POLICY = RetryPolicy(maximum_attempts=FUZZ_MAX_ATTEMPTS)


@dataclass(frozen=True, slots=True)
class RoleOutcome:
    status: RunScenarioStatus
    verdict: Verdict
    cases_run: int = 0
    failures_total: int = 0


def canceled_outcome(reason: SkipReason) -> RoleOutcome:
    return RoleOutcome(RunScenarioStatus.canceled, skipped_verdict(reason, "the run was stopped"))


def errored_outcome(reason: str) -> RoleOutcome:
    return RoleOutcome(RunScenarioStatus.errored, uncertain_verdict(ATTEMPT_ERRORED, reason))


def settled_outcome(result: RunSchemathesisResult) -> RoleOutcome:
    if result.skip_reason is not None:
        return RoleOutcome(
            RunScenarioStatus.skipped, skipped_verdict(result.skip_reason, result.detail)
        )
    if result.failures:
        first = result.failures[0]
        reason = (
            f"{len(result.failures)} finding(s) from the OpenAPI fuzz, first: "
            f"{first.operation} {first.check}"
        )
        return RoleOutcome(
            RunScenarioStatus.finished,
            fail_verdict(reason, TIER0_FAILED),
            result.cases_run,
            len(result.failures),
        )
    if result.detail is not None:
        return RoleOutcome(
            RunScenarioStatus.finished,
            uncertain_verdict(FUZZ_INCOMPLETE, result.detail),
            result.cases_run,
        )
    return RoleOutcome(RunScenarioStatus.finished, pass_verdict(), result.cases_run)


@workflow.defn(name=FUZZ_FAMILY_WORKFLOW)
class FuzzFamilyWorkflow:
    def __init__(self) -> None:
        self.cancel_requested = False
        self.cancel_reason = SkipReason.canceled
        self.fuzz_handle: workflow.ActivityHandle[RunSchemathesisResult] | None = None
        self.pending: list[FuzzRoleTarget] = []

    @workflow.signal(name=CANCEL_SIGNAL)
    def cancel(self, reason: SkipReason = SkipReason.canceled) -> None:
        if self.cancel_requested:
            return
        self.cancel_requested = True
        self.cancel_reason = reason
        if self.fuzz_handle is not None:
            self.fuzz_handle.cancel()

    @workflow.run
    async def run(self, request: FuzzFamilyInput) -> FuzzFamilyResult:
        prepared = await call_activity(
            PREPARE_FUZZ_FAMILY_ACTIVITY,
            PrepareFuzzFamilyInput(run_id=request.run_id),
            PrepareFuzzFamilyResult,
        )
        self.pending = list(prepared.roles)
        cases_run = 0
        failures_total = 0
        try:
            for target in prepared.roles:
                outcome = await self.fuzz_role(request, prepared, target)
                self.pending.remove(target)
                cases_run += outcome.cases_run
                failures_total += outcome.failures_total
        except asyncio.CancelledError:
            self.cancel_requested = True
            await self.close_pending(canceled_outcome(self.cancel_reason))
            raise
        except ActivityError as error:
            await self.close_pending(errored_outcome(failure_text(error)))
            raise
        return FuzzFamilyResult(
            roles_total=len(prepared.roles),
            cases_run=cases_run,
            failures_total=failures_total,
            notice=prepared.notice,
        )

    async def close_pending(self, outcome: RoleOutcome) -> None:
        for target in list(self.pending):
            await call_activity_without_result(
                FINISH_RUN_SCENARIO,
                FinishRunScenarioInput(
                    run_scenario_id=target.run_scenario_id,
                    status=outcome.status,
                    verdict=outcome.verdict,
                ),
            )
            self.pending.remove(target)

    async def fuzz_role(
        self, request: FuzzFamilyInput, prepared: PrepareFuzzFamilyResult, target: FuzzRoleTarget
    ) -> RoleOutcome:
        if self.cancel_requested:
            outcome = canceled_outcome(self.cancel_reason)
        else:
            await call_activity_without_result(
                BEGIN_SCENARIO_ATTEMPT,
                BeginScenarioAttemptInput(run_scenario_id=target.run_scenario_id, attempt=ATTEMPT),
            )
            outcome = await self.fuzz(request, prepared, target)
            await call_activity_without_result(
                RECORD_SCENARIO_ATTEMPT,
                RecordScenarioAttemptInput(
                    run_scenario_id=target.run_scenario_id,
                    attempt=ATTEMPT,
                    status=outcome.status,
                    verdict=outcome.verdict,
                ),
            )
        await call_activity_without_result(
            FINISH_RUN_SCENARIO,
            FinishRunScenarioInput(
                run_scenario_id=target.run_scenario_id,
                status=outcome.status,
                verdict=outcome.verdict,
            ),
        )
        return outcome

    async def fuzz(
        self, request: FuzzFamilyInput, prepared: PrepareFuzzFamilyResult, target: FuzzRoleTarget
    ) -> RoleOutcome:
        handle: workflow.ActivityHandle[RunSchemathesisResult] = workflow.start_activity(
            RUN_SCHEMATHESIS_ACTIVITY,
            RunSchemathesisInput(
                run_id=request.run_id,
                run_scenario_id=target.run_scenario_id,
                role=target.role,
                openapi_ref=prepared.openapi_ref or "",
            ),
            result_type=RunSchemathesisResult,
            start_to_close_timeout=timedelta(seconds=prepared.timeout_seconds)
            + FUZZ_START_TO_CLOSE_MARGIN,
            heartbeat_timeout=FUZZ_HEARTBEAT_TIMEOUT,
            retry_policy=FUZZ_RETRY_POLICY,
            cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
        )
        self.fuzz_handle = handle
        try:
            return settled_outcome(await handle)
        except ActivityError as error:
            if isinstance(error.cause, CancelledError):
                return canceled_outcome(self.cancel_reason)
            return errored_outcome(failure_text(error))
        except asyncio.CancelledError:
            if self.cancel_requested:
                return canceled_outcome(self.cancel_reason)
            raise
        finally:
            self.fuzz_handle = None


__all__ = ["FuzzFamilyWorkflow"]
