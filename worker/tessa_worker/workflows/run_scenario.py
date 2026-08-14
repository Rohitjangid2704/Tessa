import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import timedelta
from uuid import UUID

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, CancelledError, ChildWorkflowError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.common import Verdict
    from tessa_api.schemas.enums import InvariantPack, RunScenarioStatus, SkipReason
    from tessa_api.schemas.grading import GradePolicy
    from tessa_api.schemas.runs import RunScenarioAttempt
    from tessa_api.schemas.temporal import (
        CANCEL_SIGNAL,
        DRIVE_HEARTBEAT_TIMEOUT,
        DRIVE_MAX_ATTEMPTS,
        DRIVE_SCENARIO_ATTEMPT_ACTIVITY,
        DRIVE_START_TO_CLOSE_MARGIN,
        EVALUATE_INVARIANTS_ACTIVITY,
        GRADE_STEP_WORKFLOW,
        INVARIANTS_START_TO_CLOSE,
        RUN_SCENARIO_WORKFLOW,
        AttemptResult,
        DriveAttemptInput,
        EvaluateInvariantsInput,
        GradeStepInput,
        GradeStepResult,
        InvariantResultBatch,
        RunScenarioInput,
        RunScenarioResult,
        grade_step_workflow_id,
    )
    from tessa_api.services.grading_rules import MachineGrading
    from tessa_api.services.verdicts import (
        INVARIANTS_UNAVAILABLE,
        attempt_verdict,
        deciding_invariant_verdicts,
    )
    from tessa_worker.activities.grading_models import (
        LIST_ATTEMPT_STEPS,
        RECORD_STEP_GRADE,
        RESOLVE_GRADE_POLICY,
        ListAttemptStepsInput,
        ListAttemptStepsResult,
        RecordStepGradeInput,
        RecordStepGradeResult,
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
        aggregate_attempt_verdicts,
        skipped_verdict,
        uncertain_verdict,
    )
    from tessa_worker.workflows.calls import (
        call_activity,
        call_activity_without_argument,
        call_activity_without_result,
        failure_text,
    )

DRIVE_RETRY_POLICY = RetryPolicy(maximum_attempts=DRIVE_MAX_ATTEMPTS)
STEP_GRADING_FAILED = "step_grading_failed"
USD_DECIMALS = 6


@dataclass(frozen=True, slots=True)
class AttemptGradingInput:
    run_id: UUID
    run_scenario_id: UUID
    attempt: int
    code_laya_only: bool = False


@dataclass(frozen=True, slots=True)
class AttemptGrading:
    step_verdicts: tuple[Verdict, ...] = ()
    spent_usd: float = 0.0


@dataclass(frozen=True, slots=True)
class AttemptOutcome:
    attempt: int
    status: RunScenarioStatus
    verdict: Verdict | None


def canceled_attempt() -> AttemptResult:
    return AttemptResult(
        status=RunScenarioStatus.canceled,
        steps_recorded=0,
        cost_usd=0.0,
        browser_session_id=None,
        verdict=None,
        error=None,
    )


def errored_attempt(reason: str) -> AttemptResult:
    return AttemptResult(
        status=RunScenarioStatus.errored,
        steps_recorded=0,
        cost_usd=0.0,
        browser_session_id=None,
        verdict=uncertain_verdict(ATTEMPT_ERRORED, reason),
        error=reason,
    )


def summarize_scenario(
    outcomes: Sequence[AttemptOutcome], attempts_planned: int, cancel_reason: SkipReason | None
) -> tuple[RunScenarioStatus, Verdict]:
    if cancel_reason is not None or any(
        outcome.status is RunScenarioStatus.canceled for outcome in outcomes
    ):
        reason = cancel_reason or SkipReason.canceled
        return RunScenarioStatus.canceled, skipped_verdict(
            reason, f"stopped after {len(outcomes)} of {attempts_planned} attempts"
        )
    verdicts = [outcome.verdict for outcome in outcomes if outcome.verdict is not None]
    if outcomes and all(outcome.status is RunScenarioStatus.errored for outcome in outcomes):
        return RunScenarioStatus.errored, aggregate_attempt_verdicts(verdicts)
    if outcomes and all(outcome.status is RunScenarioStatus.skipped for outcome in outcomes):
        return RunScenarioStatus.skipped, aggregate_attempt_verdicts(verdicts)
    return RunScenarioStatus.finished, aggregate_attempt_verdicts(verdicts)


@workflow.defn(name=RUN_SCENARIO_WORKFLOW)
class RunScenarioWorkflow:
    def __init__(self) -> None:
        self.cancel_requested = False
        self.cancel_reason = SkipReason.canceled
        self.drive_handle: workflow.ActivityHandle[AttemptResult] | None = None

    @workflow.signal(name=CANCEL_SIGNAL)
    def cancel(self, reason: SkipReason = SkipReason.canceled) -> None:
        if self.cancel_requested:
            return
        self.cancel_requested = True
        self.cancel_reason = reason
        if self.drive_handle is not None:
            self.drive_handle.cancel()

    @workflow.run
    async def run(self, request: RunScenarioInput) -> RunScenarioResult:
        outcomes: list[AttemptOutcome] = []
        spent_usd = 0.0
        try:
            for attempt in range(request.attempts):
                if self.cancel_requested:
                    break
                outcome, attempt_spent = await self.run_attempt(request, attempt)
                outcomes.append(outcome)
                spent_usd += attempt_spent
                if outcome.status in {RunScenarioStatus.canceled, RunScenarioStatus.skipped}:
                    break
        except asyncio.CancelledError:
            self.cancel_requested = True
            await self.finish(request, outcomes)
            raise
        return await self.finish(request, outcomes, spent_usd)

    async def finish(
        self, request: RunScenarioInput, outcomes: Sequence[AttemptOutcome], spent_usd: float = 0.0
    ) -> RunScenarioResult:
        status, verdict = summarize_scenario(
            outcomes, request.attempts, self.cancel_reason if self.cancel_requested else None
        )
        await call_activity_without_result(
            FINISH_RUN_SCENARIO,
            FinishRunScenarioInput(
                run_scenario_id=request.run_scenario_id, status=status, verdict=verdict
            ),
        )
        return RunScenarioResult(
            run_scenario_id=request.run_scenario_id,
            verdict=verdict,
            attempts=[
                RunScenarioAttempt(
                    attempt=outcome.attempt, status=outcome.status, verdict=outcome.verdict
                )
                for outcome in outcomes
            ],
            spent_usd=spent_usd,
        )

    async def run_attempt(
        self, request: RunScenarioInput, attempt: int
    ) -> tuple[AttemptOutcome, float]:
        await call_activity_without_result(
            BEGIN_SCENARIO_ATTEMPT,
            BeginScenarioAttemptInput(run_scenario_id=request.run_scenario_id, attempt=attempt),
        )
        result = canceled_attempt() if self.cancel_requested else await self.drive(request, attempt)
        if result.status is RunScenarioStatus.finished and result.verdict is None:
            result = errored_attempt("the attempt finished without a verdict")
        spent_usd = 0.0
        if result.status is RunScenarioStatus.finished and result.verdict is not None:
            grading = await self.grade_attempt(
                AttemptGradingInput(
                    run_id=request.run_id,
                    run_scenario_id=request.run_scenario_id,
                    attempt=attempt,
                    code_laya_only=request.code_laya_only,
                )
            )
            invariant_verdicts = await self.check_invariants(request, attempt)
            result = result.model_copy(
                update={
                    "verdict": attempt_verdict(
                        result.verdict, grading.step_verdicts, invariant_verdicts
                    )
                }
            )
            spent_usd += grading.spent_usd
        await call_activity_without_result(
            RECORD_SCENARIO_ATTEMPT,
            RecordScenarioAttemptInput(
                run_scenario_id=request.run_scenario_id,
                attempt=attempt,
                status=result.status,
                verdict=result.verdict,
            ),
        )
        return AttemptOutcome(attempt, result.status, result.verdict), spent_usd

    async def drive(self, request: RunScenarioInput, attempt: int) -> AttemptResult:
        handle: workflow.ActivityHandle[AttemptResult] = workflow.start_activity(
            DRIVE_SCENARIO_ATTEMPT_ACTIVITY,
            DriveAttemptInput(
                run_id=request.run_id,
                run_scenario_id=request.run_scenario_id,
                attempt=attempt,
                read_only=request.read_only,
            ),
            result_type=AttemptResult,
            start_to_close_timeout=timedelta(seconds=request.timeout_seconds)
            + DRIVE_START_TO_CLOSE_MARGIN,
            heartbeat_timeout=DRIVE_HEARTBEAT_TIMEOUT,
            retry_policy=DRIVE_RETRY_POLICY,
            cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
        )
        self.drive_handle = handle
        try:
            return await handle
        except ActivityError as error:
            if isinstance(error.cause, CancelledError):
                return canceled_attempt()
            return errored_attempt(failure_text(error))
        except asyncio.CancelledError:
            if self.cancel_requested:
                return canceled_attempt()
            raise
        finally:
            self.drive_handle = None

    async def check_invariants(self, request: RunScenarioInput, attempt: int) -> list[Verdict]:
        if self.cancel_requested:
            return []
        try:
            evaluated = await call_activity(
                EVALUATE_INVARIANTS_ACTIVITY,
                EvaluateInvariantsInput(
                    run_id=request.run_id,
                    run_scenario_id=request.run_scenario_id,
                    attempt=attempt,
                    pack_ids=list(InvariantPack),
                ),
                InvariantResultBatch,
                INVARIANTS_START_TO_CLOSE,
            )
        except ActivityError as error:
            return [uncertain_verdict(INVARIANTS_UNAVAILABLE, failure_text(error))]
        return deciding_invariant_verdicts(evaluated.results)

    async def grade_attempt(self, attempt: AttemptGradingInput) -> AttemptGrading:
        listing = await call_activity(
            LIST_ATTEMPT_STEPS,
            ListAttemptStepsInput(run_scenario_id=attempt.run_scenario_id, attempt=attempt.attempt),
            ListAttemptStepsResult,
        )
        if not listing.step_ids:
            return AttemptGrading()
        policy = await call_activity_without_argument(RESOLVE_GRADE_POLICY, GradePolicy)
        if attempt.code_laya_only:
            policy = policy.without_judge()
        decided = {item.step_id: item.grading for item in listing.decided}
        step_verdicts: list[Verdict] = []
        spent_usd = 0.0
        for step_id in listing.step_ids:
            if self.cancel_requested:
                break
            graded = await self.grade_step(attempt.run_id, step_id, policy, decided.get(step_id))
            step_verdicts.append(graded.verdict)
            spent_usd = round(spent_usd + graded.spent_usd, USD_DECIMALS)
        return AttemptGrading(step_verdicts=tuple(step_verdicts), spent_usd=spent_usd)

    async def grade_step(
        self, run_id: UUID, step_id: UUID, policy: GradePolicy, decided: MachineGrading | None
    ) -> GradeStepResult:
        if decided is not None:
            return await self.record_decided_step(run_id, step_id, decided)
        try:
            graded: GradeStepResult = await workflow.execute_child_workflow(
                GRADE_STEP_WORKFLOW,
                GradeStepInput(step_id=step_id, run_id=run_id, policy=policy),
                id=grade_step_workflow_id(step_id),
                result_type=GradeStepResult,
            )
            return graded
        except ChildWorkflowError as error:
            return GradeStepResult(
                verdict=uncertain_verdict(STEP_GRADING_FAILED, failure_text(error)),
                escalated_to=None,
                spent_usd=0.0,
            )

    async def record_decided_step(
        self, run_id: UUID, step_id: UUID, decided: MachineGrading
    ) -> GradeStepResult:
        try:
            recorded = await call_activity(
                RECORD_STEP_GRADE,
                RecordStepGradeInput(
                    step_id=step_id,
                    run_id=run_id,
                    verdict=decided.verdict,
                    escalated_to=decided.escalated_to,
                    review_reasons=decided.review_reasons,
                ),
                RecordStepGradeResult,
            )
        except ActivityError:
            return GradeStepResult(
                verdict=decided.verdict, escalated_to=decided.escalated_to, spent_usd=0.0
            )
        return GradeStepResult(
            verdict=recorded.verdict, escalated_to=recorded.escalated_to, spent_usd=0.0
        )


__all__ = ["RunScenarioWorkflow"]
