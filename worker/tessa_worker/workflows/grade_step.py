from dataclasses import replace
from datetime import timedelta
from uuid import UUID

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.enums import JudgeOrder
    from tessa_api.schemas.grading import (
        EvidenceBlock,
        JudgeStepInput,
        JudgeStepOutput,
        ProbeBatchResult,
    )
    from tessa_api.schemas.probes import ProbeResult
    from tessa_api.schemas.steps import Tier0Result
    from tessa_api.schemas.temporal import (
        GRADE_STEP_WORKFLOW,
        JUDGE_STEP_ACTIVITY,
        JUDGE_TIEBREAK_ACTIVITY,
        LAYA_PROBES_MAX_ATTEMPTS,
        LAYA_PROBES_START_TO_CLOSE,
        RUN_LAYA_PROBES_ACTIVITY,
        RUN_TIER0_CHECKS_ACTIVITY,
        STORE_WEAK_LABEL_ACTIVITY,
        GradeStepInput,
        GradeStepResult,
        RunLayaProbesInput,
        RunTier0ChecksInput,
        StoreWeakLabelInput,
        StoreWeakLabelResult,
    )
    from tessa_worker.activities.grading_models import (
        LOAD_STEP_GRADING,
        RECORD_STEP_GRADE,
        LoadStepGradingInput,
        RecordStepGradeInput,
        RecordStepGradeResult,
        StepGradingContext,
    )
    from tessa_worker.activities.judge_models import BuildStepEvidenceInput
    from tessa_worker.activities.names import BUILD_STEP_EVIDENCE
    from tessa_worker.grading.errors import GradingErrorType
    from tessa_worker.grading.escalation import (
        BUDGET_EXHAUSTED,
        GRADING_UNAVAILABLE,
        JUDGE_DISABLED,
        JUDGE_DISABLED_REASON,
        JUDGE_UNAVAILABLE,
        TIEBREAK_UNAVAILABLE,
        TIER0_UNAVAILABLE,
        Graded,
        JudgeCall,
        JudgeOutcome,
        JudgeStage,
        JudgeState,
        JudgeUnavailable,
        ProbeReading,
        ProbeStage,
        decide_escalation,
        probe_reading,
        unresolved,
    )
    from tessa_worker.workflows.calls import call_activity, failure_text

MODEL_CALL_TIMEOUT_MARGIN = timedelta(seconds=10)
USD_DECIMALS = 6
UNAVAILABLE_CODE_BY_ERROR_TYPE = {
    GradingErrorType.budget_exceeded.value: BUDGET_EXHAUSTED,
    GradingErrorType.provider_key_missing.value: JUDGE_UNAVAILABLE,
    GradingErrorType.tiebreak_unavailable.value: TIEBREAK_UNAVAILABLE,
}


def unavailable_from(error: ActivityError, default_code: str) -> JudgeUnavailable:
    cause = error.cause
    error_type = cause.type if isinstance(cause, ApplicationError) else None
    code = UNAVAILABLE_CODE_BY_ERROR_TYPE.get(error_type or "", default_code)
    return JudgeUnavailable(code, failure_text(error))


@workflow.defn(name=GRADE_STEP_WORKFLOW)
class GradeStepWorkflow:
    def __init__(self) -> None:
        self.spent_usd = 0.0
        self.judge_result_ids: list[UUID] = []
        self.first_result_id: UUID | None = None
        self.evidence: EvidenceBlock | None = None

    @workflow.run
    async def run(self, request: GradeStepInput) -> GradeStepResult:
        try:
            context = await call_activity(
                LOAD_STEP_GRADING,
                LoadStepGradingInput(step_id=request.step_id, run_id=request.run_id),
                StepGradingContext,
            )
        except ActivityError as error:
            return await self.abandon(request, unresolved(GRADING_UNAVAILABLE, failure_text(error)))
        tier0 = context.tier0 if context.tier0 is not None else await self.recompute_tier0(request)
        if tier0 is None:
            return await self.conclude(
                request, unresolved(TIER0_UNAVAILABLE, "tier 0 could not be evaluated for the step")
            )
        return await self.conclude(request, await self.grade(request, context, tier0))

    async def recompute_tier0(self, request: GradeStepInput) -> Tier0Result | None:
        try:
            return await call_activity(
                RUN_TIER0_CHECKS_ACTIVITY, RunTier0ChecksInput(step_id=request.step_id), Tier0Result
            )
        except ActivityError as error:
            workflow.logger.warning("tier0_not_recomputed", extra={"cause": failure_text(error)})
            return None

    async def grade(
        self, request: GradeStepInput, context: StepGradingContext, tier0: Tier0Result
    ) -> Graded:
        probes = ProbeStage()
        if tier0.passed and context.step_completed:
            probes = await self.run_probes(request, context)
        judge = JudgeState()
        decision = decide_escalation(
            tier0, probes, judge, request.policy, step_completed=context.step_completed
        )
        for _ in JudgeStage:
            if isinstance(decision, Graded):
                return decision
            workflow.logger.info(
                "grade_step_escalating",
                extra={"stage": decision.stage.value, "reason": decision.reason},
            )
            judge = await self.advance(decision.stage, judge, request, context)
            decision = decide_escalation(
                tier0, probes, judge, request.policy, step_completed=context.step_completed
            )
        if isinstance(decision, Graded):
            return decision
        return unresolved(GRADING_UNAVAILABLE, "the escalation did not settle on a verdict")

    async def run_probes(self, request: GradeStepInput, context: StepGradingContext) -> ProbeStage:
        try:
            batch = await workflow.execute_activity(
                RUN_LAYA_PROBES_ACTIVITY,
                RunLayaProbesInput(step_id=request.step_id, probe_ids=[]),
                result_type=ProbeBatchResult,
                start_to_close_timeout=LAYA_PROBES_START_TO_CLOSE,
                retry_policy=RetryPolicy(maximum_attempts=LAYA_PROBES_MAX_ATTEMPTS),
            )
        except ActivityError as error:
            return ProbeStage(failure=failure_text(error))
        return ProbeStage(readings=tuple(reading_of(result, context) for result in batch.results))

    async def advance(
        self,
        stage: JudgeStage,
        judge: JudgeState,
        request: GradeStepInput,
        context: StepGradingContext,
    ) -> JudgeState:
        if not request.policy.judge_enabled:
            return judge_switched_off(stage, judge)
        if stage is JudgeStage.judge:
            return await self.first_order(judge, request, context)
        if stage is JudgeStage.swapped:
            return replace(judge, swapped=await self.second_order(request, context))
        return replace(judge, tiebreak=await self.tiebreak(request, context))

    async def first_order(
        self, judge: JudgeState, request: GradeStepInput, context: StepGradingContext
    ) -> JudgeState:
        try:
            evidence = await call_activity(
                BUILD_STEP_EVIDENCE, BuildStepEvidenceInput(step_id=request.step_id), EvidenceBlock
            )
        except ActivityError as error:
            reason = f"the evidence block could not be built: {failure_text(error)}"
            return replace(judge, first=JudgeUnavailable(JUDGE_UNAVAILABLE, reason))
        self.evidence = evidence
        result = await self.call_model(
            JUDGE_STEP_ACTIVITY,
            JudgeStepInput(
                step_id=request.step_id,
                evidence=evidence,
                order=JudgeOrder.a_b,
                spec=context.judge_spec,
            ),
            JUDGE_UNAVAILABLE,
        )
        reference_exists = bool(evidence.gold_points)
        if isinstance(result, JudgeUnavailable):
            return replace(judge, reference_exists=reference_exists, first=result)
        self.first_result_id = result.judge_result_id
        return replace(judge, reference_exists=reference_exists, first=judge_call_of(result))

    async def second_order(
        self, request: GradeStepInput, context: StepGradingContext
    ) -> JudgeOutcome:
        if self.evidence is None or self.first_result_id is None:
            return JudgeUnavailable(JUDGE_UNAVAILABLE, "the first order result is missing")
        result = await self.call_model(
            JUDGE_STEP_ACTIVITY,
            JudgeStepInput(
                step_id=request.step_id,
                evidence=self.evidence,
                order=JudgeOrder.b_a,
                spec=context.judge_spec,
                paired_with=self.first_result_id,
            ),
            JUDGE_UNAVAILABLE,
        )
        return result if isinstance(result, JudgeUnavailable) else judge_call_of(result)

    async def tiebreak(self, request: GradeStepInput, context: StepGradingContext) -> JudgeOutcome:
        if self.evidence is None:
            return JudgeUnavailable(TIEBREAK_UNAVAILABLE, "the evidence block is missing")
        result = await self.call_model(
            JUDGE_TIEBREAK_ACTIVITY,
            JudgeStepInput(
                step_id=request.step_id,
                evidence=self.evidence,
                order=JudgeOrder.a_b,
                spec=context.tiebreak_spec,
            ),
            TIEBREAK_UNAVAILABLE,
        )
        return result if isinstance(result, JudgeUnavailable) else judge_call_of(result)

    async def call_model(
        self, activity_name: str, call: JudgeStepInput, default_code: str
    ) -> JudgeStepOutput | JudgeUnavailable:
        spec = call.spec
        try:
            output: JudgeStepOutput = await workflow.execute_activity(
                activity_name,
                call,
                result_type=JudgeStepOutput,
                start_to_close_timeout=timedelta(seconds=spec.start_to_close_timeout_seconds)
                + MODEL_CALL_TIMEOUT_MARGIN,
                retry_policy=RetryPolicy(maximum_attempts=spec.max_attempts),
            )
        except ActivityError as error:
            return unavailable_from(error, default_code)
        self.spent_usd = round(self.spent_usd + output.cost_usd, USD_DECIMALS)
        if output.judge_result_id not in self.judge_result_ids:
            self.judge_result_ids.append(output.judge_result_id)
        return output

    async def store_weak_labels(self) -> None:
        for judge_result_id in self.judge_result_ids:
            try:
                await call_activity(
                    STORE_WEAK_LABEL_ACTIVITY,
                    StoreWeakLabelInput(judge_result_id=judge_result_id),
                    StoreWeakLabelResult,
                )
            except ActivityError as error:
                workflow.logger.warning(
                    "weak_label_not_stored",
                    extra={"judge_result_id": str(judge_result_id), "cause": failure_text(error)},
                )

    async def record(self, request: GradeStepInput, decision: Graded) -> RecordStepGradeResult:
        return await call_activity(
            RECORD_STEP_GRADE,
            RecordStepGradeInput(
                step_id=request.step_id,
                run_id=request.run_id,
                verdict=decision.verdict,
                escalated_to=decision.escalated_to,
                review_reasons=list(decision.review_reasons),
            ),
            RecordStepGradeResult,
        )

    async def conclude(self, request: GradeStepInput, decision: Graded) -> GradeStepResult:
        await self.store_weak_labels()
        recorded = await self.record(request, decision)
        return GradeStepResult(
            verdict=recorded.verdict,
            escalated_to=recorded.escalated_to,
            spent_usd=self.spent_usd,
        )

    async def abandon(self, request: GradeStepInput, decision: Graded) -> GradeStepResult:
        try:
            await self.record(request, decision)
        except ActivityError as error:
            workflow.logger.warning("grade_not_recorded", extra={"cause": failure_text(error)})
        return GradeStepResult(verdict=decision.verdict, escalated_to=None, spent_usd=0.0)


def judge_switched_off(stage: JudgeStage, judge: JudgeState) -> JudgeState:
    outcome = JudgeUnavailable(JUDGE_DISABLED, JUDGE_DISABLED_REASON)
    if stage is JudgeStage.judge:
        return replace(judge, first=outcome)
    if stage is JudgeStage.swapped:
        return replace(judge, swapped=outcome)
    return replace(judge, tiebreak=outcome)


def judge_call_of(output: JudgeStepOutput) -> JudgeCall:
    return JudgeCall(verdict=output.verdict, swapped_agrees=output.swapped_agrees)


def reading_of(result: ProbeResult, context: StepGradingContext) -> ProbeReading:
    polarity = context.probe_polarity.get(result.probe_id)
    if polarity is None:
        return probe_reading(result, None, ())
    return probe_reading(result, polarity.compliant_answer, polarity.allowed_answers)


__all__ = ["GradeStepWorkflow"]
