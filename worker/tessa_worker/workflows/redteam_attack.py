import asyncio
from dataclasses import dataclass
from datetime import timedelta
from uuid import UUID

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError, FailureError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.common import Verdict
    from tessa_api.schemas.enums import AttackOutcome, RunScenarioStatus, SkipReason
    from tessa_api.schemas.grading import ModelCallSpec
    from tessa_api.schemas.temporal import (
        CANCEL_SIGNAL,
        DRIVE_HEARTBEAT_TIMEOUT,
        DRIVE_MAX_ATTEMPTS,
        DRIVE_SCENARIO_ATTEMPT_ACTIVITY,
        DRIVE_START_TO_CLOSE_MARGIN,
        RESOLVE_MODEL_SPECS_ACTIVITY,
        SKEPTIC_TEXT_MAX_CHARS,
        SKEPTIC_VERIFY_ACTIVITY,
        AttemptResult,
        DriveAttemptInput,
        ResolveModelSpecsResult,
        SkepticEvidence,
        SkepticVerifyInput,
        SkepticVerifyOutput,
    )
    from tessa_worker.activities.names import (
        BEGIN_SCENARIO_ATTEMPT,
        FINISH_RUN_SCENARIO,
        RECORD_SCENARIO_ATTEMPT,
    )
    from tessa_worker.activities.redteam_models import (
        ASSESS_ATTACK,
        ASSESS_START_TO_CLOSE,
        ATTACK_PIPELINE_WORKFLOW,
        MODEL_TIMEOUT_MARGIN,
        PREPARE_ATTACK,
        PREPARE_ATTACK_REPLAYS,
        PREPARE_START_TO_CLOSE,
        SETTLE_ATTACK,
        SETTLE_START_TO_CLOSE,
        AssessAttackInput,
        AttackAssessment,
        AttackPipelineInput,
        AttackPipelineResult,
        DeliveryReport,
        PrepareAttackInput,
        PrepareAttackReplaysInput,
        PreparedAttack,
        PreparedReplays,
        SettleAttackInput,
        SettleAttackResult,
    )
    from tessa_worker.activities.run_models import (
        BeginScenarioAttemptInput,
        FinishRunScenarioInput,
        RecordScenarioAttemptInput,
    )
    from tessa_worker.grading.errors import GradingErrorType
    from tessa_worker.lab.redteam.canary import canary_for
    from tessa_worker.lab.redteam.confirm import (
        CONFIRM_REPLAYS,
        attack_scenario_verdict,
        is_confirmed,
        not_reproduced_verdict,
        replay_scenario_verdict,
        reproduced_count,
        reproduction_is_enough,
        skeptic_unavailable_verdict,
    )
    from tessa_worker.verdicts import (
        ATTEMPT_ERRORED,
        SCENARIO_WORKFLOW_FAILED,
        skipped_verdict,
        uncertain_verdict,
    )
    from tessa_worker.workflows.calls import (
        call_activity,
        call_activity_without_argument,
        call_activity_without_result,
        failure_text,
    )

MAX_NOTICES = 5
FIRST_ATTEMPT = 0
BUDGET_ERROR_TYPE = GradingErrorType.budget_exceeded.value
CANCELED_BEFORE_VERIFICATION = "the attack was canceled before verification"


@dataclass(frozen=True, slots=True)
class Confirmation:
    confirmed: bool = False
    reproduced: int = 0
    replays: int = 0
    verdict: Verdict | None = None
    finding_id: UUID | None = None


def error_type_of(error: ActivityError) -> str | None:
    cause = error.cause
    return cause.type if isinstance(cause, ApplicationError) else None


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


def delivery_report(result: AttemptResult) -> DeliveryReport:
    return DeliveryReport(status=result.status, error=result.error)


def model_timeout(spec: ModelCallSpec) -> timedelta:
    return timedelta(seconds=spec.start_to_close_timeout_seconds) + MODEL_TIMEOUT_MARGIN


@workflow.defn(name=ATTACK_PIPELINE_WORKFLOW)
class AttackPipelineWorkflow:
    def __init__(self) -> None:
        self.cancel_requested = False
        self.budget_exceeded = False
        self.pending: list[UUID] = []
        self.drive_handle: workflow.ActivityHandle[AttemptResult] | None = None
        self.notices: list[str] = []

    @workflow.signal(name=CANCEL_SIGNAL)
    def cancel(self) -> None:
        self.cancel_requested = True
        if self.drive_handle is not None:
            self.drive_handle.cancel()

    @workflow.run
    async def run(self, request: AttackPipelineInput) -> AttackPipelineResult:
        try:
            return await self.attack(request)
        except asyncio.CancelledError:
            self.cancel_requested = True
            await self.cancel_pending()
            raise
        except ActivityError as error:
            reason = failure_text(error)
            await self.fail_pending(reason)
            raise ApplicationError(reason, type=error_type_of(error), non_retryable=True) from error
        except Exception as error:
            reason = failure_text(error)
            await self.fail_pending(reason)
            if isinstance(error, FailureError):
                raise
            raise ApplicationError(reason, non_retryable=True) from error

    async def attack(self, request: AttackPipelineInput) -> AttackPipelineResult:
        prepared = await call_activity(
            PREPARE_ATTACK,
            PrepareAttackInput(
                run_id=request.run_id,
                family=request.family,
                ordinal=request.ordinal,
                role=request.role,
                interface_id=request.interface_id,
                prompt=request.prompt,
                canary=canary_for(request.run_id, request.family, request.ordinal),
            ),
            PreparedAttack,
            PREPARE_START_TO_CLOSE,
        )
        self.pending.append(prepared.run_scenario_id)
        delivery = await self.deliver(
            request.run_id, prepared, prepared.run_scenario_id, FIRST_ATTEMPT
        )
        if self.cancel_requested:
            return await self.canceled(prepared, None, Confirmation())
        assessment = await call_activity(
            ASSESS_ATTACK,
            AssessAttackInput(
                run_id=request.run_id,
                attack_id=prepared.attack_id,
                record=True,
                family=request.family,
                run_scenario_id=prepared.run_scenario_id,
                attempt=FIRST_ATTEMPT,
                prompt=prepared.prompt,
                canary=prepared.canary,
                delivery=delivery_report(delivery),
            ),
            AttackAssessment,
            ASSESS_START_TO_CLOSE,
        )
        confirmation = Confirmation()
        if assessment.outcome is AttackOutcome.breached:
            confirmation = await self.verify(request, prepared, assessment)
        if self.cancel_requested:
            return await self.canceled(prepared, assessment.outcome, confirmation)
        verdict = attack_scenario_verdict(
            assessment.outcome, confirmation.confirmed, assessment.breach_signal
        )
        await self.record_attempt(prepared.run_scenario_id, FIRST_ATTEMPT, delivery, verdict)
        await self.finish_scenario(prepared.run_scenario_id, delivery, verdict)
        return self.result(prepared, assessment.outcome, confirmation, False)

    def result(
        self,
        prepared: PreparedAttack,
        outcome: AttackOutcome | None,
        confirmation: Confirmation,
        canceled: bool,
    ) -> AttackPipelineResult:
        return AttackPipelineResult(
            attack_id=prepared.attack_id,
            outcome=outcome,
            confirmed=confirmation.confirmed,
            reproduced=confirmation.reproduced,
            replays=confirmation.replays,
            skeptic_verdict=confirmation.verdict,
            finding_id=confirmation.finding_id,
            canceled=canceled,
            budget_exceeded=self.budget_exceeded,
            notices=list(self.notices),
        )

    async def canceled(
        self,
        prepared: PreparedAttack,
        outcome: AttackOutcome | None,
        confirmation: Confirmation,
    ) -> AttackPipelineResult:
        await self.cancel_pending()
        return self.result(prepared, outcome, confirmation, True)

    async def deliver(
        self, run_id: UUID, prepared: PreparedAttack, run_scenario_id: UUID, attempt: int
    ) -> AttemptResult:
        await call_activity_without_result(
            BEGIN_SCENARIO_ATTEMPT,
            BeginScenarioAttemptInput(run_scenario_id=run_scenario_id, attempt=attempt),
        )
        if self.cancel_requested:
            return canceled_attempt()
        handle: workflow.ActivityHandle[AttemptResult] = workflow.start_activity(
            DRIVE_SCENARIO_ATTEMPT_ACTIVITY,
            DriveAttemptInput(
                run_id=run_id,
                run_scenario_id=run_scenario_id,
                attempt=attempt,
                read_only=False,
            ),
            result_type=AttemptResult,
            start_to_close_timeout=timedelta(seconds=prepared.session_timeout_seconds)
            + DRIVE_START_TO_CLOSE_MARGIN,
            heartbeat_timeout=DRIVE_HEARTBEAT_TIMEOUT,
            retry_policy=RetryPolicy(maximum_attempts=DRIVE_MAX_ATTEMPTS),
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

    async def verify(
        self,
        request: AttackPipelineInput,
        prepared: PreparedAttack,
        assessment: AttackAssessment,
    ) -> Confirmation:
        replays = await call_activity(
            PREPARE_ATTACK_REPLAYS,
            PrepareAttackReplaysInput(
                run_id=request.run_id,
                attack_id=prepared.attack_id,
                family=request.family,
                role=request.role,
                interface_id=prepared.interface_id,
                prompt=prepared.prompt,
                replays=CONFIRM_REPLAYS,
            ),
            PreparedReplays,
            PREPARE_START_TO_CLOSE,
        )
        self.pending.append(replays.run_scenario_id)
        outcomes = await self.replay(request, prepared, replays)
        if self.cancel_requested:
            return Confirmation()
        reproduced = reproduced_count(outcomes)
        await self.finish_replays(replays, outcomes)
        if reproduction_is_enough(reproduced):
            verdict = await self.ask_skeptic(request, prepared, assessment)
        else:
            verdict = not_reproduced_verdict(reproduced, len(outcomes))
        weighed = Confirmation(
            confirmed=is_confirmed(verdict, reproduced),
            reproduced=reproduced,
            replays=len(outcomes),
            verdict=verdict,
        )
        return await self.settle(request, prepared, assessment, verdict, weighed)

    async def replay(
        self, request: AttackPipelineInput, prepared: PreparedAttack, replays: PreparedReplays
    ) -> list[AttackOutcome]:
        outcomes: list[AttackOutcome] = []
        for attempt in range(replays.replays):
            delivery = await self.deliver(
                request.run_id, prepared, replays.run_scenario_id, attempt
            )
            if self.cancel_requested:
                break
            assessed = await call_activity(
                ASSESS_ATTACK,
                AssessAttackInput(
                    run_id=request.run_id,
                    attack_id=prepared.attack_id,
                    record=False,
                    family=request.family,
                    run_scenario_id=replays.run_scenario_id,
                    attempt=attempt,
                    prompt=prepared.prompt,
                    canary=prepared.canary,
                    delivery=delivery_report(delivery),
                ),
                AttackAssessment,
                ASSESS_START_TO_CLOSE,
            )
            outcomes.append(assessed.outcome)
            verdict = attack_scenario_verdict(
                assessed.outcome, assessed.outcome is AttackOutcome.breached, assessed.breach_signal
            )
            await self.record_attempt(replays.run_scenario_id, attempt, delivery, verdict)
        return outcomes

    async def finish_replays(self, replays: PreparedReplays, outcomes: list[AttackOutcome]) -> None:
        await call_activity_without_result(
            FINISH_RUN_SCENARIO,
            FinishRunScenarioInput(
                run_scenario_id=replays.run_scenario_id,
                status=RunScenarioStatus.finished,
                verdict=replay_scenario_verdict(outcomes),
            ),
        )
        self.pending.remove(replays.run_scenario_id)

    async def ask_skeptic(
        self,
        request: AttackPipelineInput,
        prepared: PreparedAttack,
        assessment: AttackAssessment,
    ) -> Verdict:
        try:
            specs = await call_activity_without_argument(
                RESOLVE_MODEL_SPECS_ACTIVITY, ResolveModelSpecsResult
            )
            spec = specs.judge
            output: SkepticVerifyOutput = await workflow.execute_activity(
                SKEPTIC_VERIFY_ACTIVITY,
                SkepticVerifyInput(
                    run_id=request.run_id,
                    attack_id=prepared.attack_id,
                    evidence=SkepticEvidence(
                        family=request.family,
                        attack_prompt=prepared.prompt[:SKEPTIC_TEXT_MAX_CHARS],
                        target_response=assessment.response_text,
                        breach_signal=assessment.breach_signal,
                    ),
                    spec=spec,
                ),
                result_type=SkepticVerifyOutput,
                start_to_close_timeout=model_timeout(spec),
                retry_policy=RetryPolicy(maximum_attempts=spec.max_attempts),
            )
        except ActivityError as error:
            return self.skeptic_failure(error)
        return output.verdict

    def skeptic_failure(self, error: ActivityError) -> Verdict:
        if error_type_of(error) == BUDGET_ERROR_TYPE:
            self.budget_exceeded = True
            return skeptic_unavailable_verdict("the budget could not cover the skeptic")
        self.add_notice(f"the skeptic did not answer: {failure_text(error)}")
        return skeptic_unavailable_verdict(failure_text(error))

    async def settle(
        self,
        request: AttackPipelineInput,
        prepared: PreparedAttack,
        assessment: AttackAssessment,
        verdict: Verdict,
        confirmation: Confirmation,
    ) -> Confirmation:
        try:
            settled = await call_activity(
                SETTLE_ATTACK,
                SettleAttackInput(
                    run_id=request.run_id,
                    attack_id=prepared.attack_id,
                    family=request.family,
                    role=request.role,
                    interface_id=prepared.interface_id,
                    skeptic_verdict=verdict,
                    confirmed=confirmation.confirmed,
                    reproduced=confirmation.reproduced,
                    replays=confirmation.replays,
                    prompt=prepared.prompt,
                    assessment=assessment,
                    scenario_id=prepared.scenario_id,
                    run_scenario_id=prepared.run_scenario_id,
                ),
                SettleAttackResult,
                SETTLE_START_TO_CLOSE,
            )
        except ActivityError as error:
            self.add_notice(f"attack {prepared.attack_id} was not settled: {failure_text(error)}")
            return Confirmation(
                confirmed=False,
                reproduced=confirmation.reproduced,
                replays=confirmation.replays,
                verdict=verdict,
            )
        return Confirmation(
            confirmed=confirmation.confirmed,
            reproduced=confirmation.reproduced,
            replays=confirmation.replays,
            verdict=verdict,
            finding_id=settled.finding_id,
        )

    async def record_attempt(
        self, run_scenario_id: UUID, attempt: int, delivery: AttemptResult, verdict: Verdict
    ) -> None:
        finished = delivery.status is RunScenarioStatus.finished
        await call_activity_without_result(
            RECORD_SCENARIO_ATTEMPT,
            RecordScenarioAttemptInput(
                run_scenario_id=run_scenario_id,
                attempt=attempt,
                status=delivery.status,
                verdict=verdict if finished else delivery.verdict,
            ),
        )

    async def finish_scenario(
        self, run_scenario_id: UUID, delivery: AttemptResult, verdict: Verdict
    ) -> None:
        finished = delivery.status is RunScenarioStatus.finished
        await call_activity_without_result(
            FINISH_RUN_SCENARIO,
            FinishRunScenarioInput(
                run_scenario_id=run_scenario_id,
                status=delivery.status,
                verdict=verdict if finished else delivery.verdict,
            ),
        )
        self.pending.remove(run_scenario_id)

    async def fail_pending(self, reason: str) -> None:
        for run_scenario_id in list(self.pending):
            await call_activity_without_result(
                FINISH_RUN_SCENARIO,
                FinishRunScenarioInput(
                    run_scenario_id=run_scenario_id,
                    status=RunScenarioStatus.errored,
                    verdict=uncertain_verdict(SCENARIO_WORKFLOW_FAILED, reason),
                ),
            )
            self.pending.remove(run_scenario_id)

    async def cancel_pending(self) -> None:
        for run_scenario_id in list(self.pending):
            await call_activity_without_result(
                FINISH_RUN_SCENARIO,
                FinishRunScenarioInput(
                    run_scenario_id=run_scenario_id,
                    status=RunScenarioStatus.canceled,
                    verdict=skipped_verdict(SkipReason.canceled, CANCELED_BEFORE_VERIFICATION),
                ),
            )
            self.pending.remove(run_scenario_id)

    def add_notice(self, text: str) -> None:
        if len(self.notices) < MAX_NOTICES:
            self.notices.append(text)


__all__ = ["AttackPipelineWorkflow"]
