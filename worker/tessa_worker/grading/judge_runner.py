import asyncio
import logging
import time
import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession
from temporalio.exceptions import ApplicationError

from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.enums import JudgeFamily, ModelCallRole, ModelCallStatus, ModelRole
from tessa_api.schemas.grading import JudgeStepInput, JudgeStepOutput
from tessa_api.schemas.model_calls import ModelCallRecord
from tessa_api.schemas.temporal import JUDGE_STEP_ACTIVITY, JUDGE_TIEBREAK_ACTIVITY
from tessa_worker.activities.model_call import deterministic_call_id
from tessa_worker.activities.model_call_contracts import ModelCallRecorder
from tessa_worker.grading.errors import GradingErrorType, permanent_error, retryable_error
from tessa_worker.grading.evidence_loader import load_step
from tessa_worker.grading.judge_models import JudgeRequest, ProviderCallError, ProviderReply
from tessa_worker.grading.judge_prompt import (
    RenderedPrompt,
    estimate_tokens,
    render_judge_prompt,
)
from tessa_worker.grading.judge_providers import JudgeProviders
from tessa_worker.grading.judge_store import (
    JudgeCallRecord,
    NewJudgeResult,
    complete_pair,
    deterministic_result_id,
    insert_first_call,
    replay_first_call,
    replay_swapped_call,
    require_first_order_result,
)
from tessa_worker.grading.judge_verdict import (
    REASON_OUTPUT_INVALID,
    Interpretation,
    interpret_reply,
    stamped_as_stub,
)
from tessa_worker.grading.ledger_guard import reserve_budget
from tessa_worker.grading.pricing import (
    Charge,
    PriceTable,
    TokenUsage,
    charge_for,
    stub_charge,
)
from tessa_worker.grading.rubric import rubric_version_of
from tessa_worker.grading.stub_markers import STUB_MODEL_ID
from tessa_worker.settings import WorkerSettings
from tessa_worker.testing.stub_models import (
    StubCall,
    StubModelRegistry,
    StubRoleNotRegisteredError,
)

logger = logging.getLogger("tessa_worker.grading.judge")

ROLE_BY_FAMILY = {
    JudgeFamily.openai: ModelRole.judge,
    JudgeFamily.anthropic: ModelRole.judge_tiebreak,
}
ACTIVITY_BY_FAMILY = {
    JudgeFamily.openai: JUDGE_STEP_ACTIVITY,
    JudgeFamily.anthropic: JUDGE_TIEBREAK_ACTIVITY,
}
CALL_TIMEOUT_MARGIN_SECONDS = 5
MIN_CALL_TIMEOUT_SECONDS = 1
MILLISECONDS_PER_SECOND = 1000


@dataclass(frozen=True, slots=True)
class JudgeDependencies:
    settings: WorkerSettings
    session_factory: SessionFactory
    providers: JudgeProviders
    stubs: StubModelRegistry
    recorder: ModelCallRecorder
    price_table: PriceTable | None = None


@dataclass(frozen=True, slots=True)
class CallTarget:
    step_id: uuid.UUID
    run_id: uuid.UUID
    result_id: uuid.UUID
    paired_id: uuid.UUID | None
    family: JudgeFamily


def call_timeout_seconds(request: JudgeStepInput) -> float:
    available = request.spec.start_to_close_timeout_seconds - CALL_TIMEOUT_MARGIN_SECONDS
    return float(max(MIN_CALL_TIMEOUT_SECONDS, available))


def reject_oversized_prompt(prompt: RenderedPrompt, request: JudgeStepInput) -> None:
    estimated = estimate_tokens(prompt)
    if estimated > request.spec.max_input_tokens:
        raise permanent_error(
            GradingErrorType.input_too_large,
            f"the judge prompt is about {estimated} tokens, the limit is "
            f"{request.spec.max_input_tokens}",
        )


def application_error_of(error: ProviderCallError) -> ApplicationError:
    if error.retryable:
        return retryable_error(error.kind, str(error))
    return permanent_error(error.kind, str(error))


def missing_key_error(family: JudgeFamily) -> ApplicationError:
    if family is JudgeFamily.anthropic:
        return permanent_error(
            GradingErrorType.tiebreak_unavailable, "no Anthropic API key is configured"
        )
    return permanent_error(GradingErrorType.provider_key_missing, "no OpenAI API key is configured")


def elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * MILLISECONDS_PER_SECOND)


def output_of_new(new: NewJudgeResult) -> JudgeStepOutput:
    call = new.call
    return JudgeStepOutput(
        cost_usd=call.cost_usd,
        input_tokens=call.input_tokens,
        output_tokens=call.output_tokens,
        verdict=call.verdict,
        rationale=call.rationale,
        evidence=call.evidence,
        judge_result_id=new.id,
        swapped_agrees=None,
    )


class JudgeRunner:
    def __init__(self, dependencies: JudgeDependencies) -> None:
        self.dependencies = dependencies

    @property
    def stub_mode(self) -> bool:
        return self.dependencies.settings.stub_models

    async def run(self, request: JudgeStepInput, family: JudgeFamily) -> JudgeStepOutput:
        self.check_request(request, family)
        paired_id = request.paired_with if family is JudgeFamily.openai else None
        async with self.dependencies.session_factory() as session:
            step = await load_step(session, request.step_id)
            target = CallTarget(
                step_id=request.step_id,
                run_id=step.run_id,
                result_id=deterministic_result_id(request.step_id, family, request.order),
                paired_id=paired_id,
                family=family,
            )
            replayed = await self.replay(session, request, target)
            if replayed is not None:
                return replayed
            if paired_id is not None:
                await require_first_order_result(session, paired_id, request.step_id)
        prompt = render_judge_prompt(request.evidence, request.order)
        reject_oversized_prompt(prompt, request)
        await reserve_budget(
            self.dependencies.recorder,
            target.run_id,
            target.step_id,
            ACTIVITY_BY_FAMILY[family],
            request.spec,
            self.model_label(request),
        )
        started = time.monotonic()
        reply = await self.obtain_reply(request, family, prompt, target)
        latency_ms = elapsed_ms(started)
        charge = self.charge(request, reply)
        interpretation = interpret_reply(reply, request.evidence)
        call = self.call_record(request, interpretation, reply, charge)
        await self.dependencies.recorder.record(
            self.model_call(request, target, call, interpretation, latency_ms)
        )
        output = await self.persist(request, target, call, charge)
        self.log_call(request, target, call, charge)
        return output

    def model_label(self, request: JudgeStepInput) -> str:
        return STUB_MODEL_ID if self.stub_mode else request.spec.model

    def model_call(
        self,
        request: JudgeStepInput,
        target: CallTarget,
        call: JudgeCallRecord,
        interpretation: Interpretation,
        latency_ms: int,
    ) -> ModelCallRecord:
        invalid = interpretation.verdict.reason_code == REASON_OUTPUT_INVALID
        return ModelCallRecord(
            id=deterministic_call_id(
                ACTIVITY_BY_FAMILY[target.family],
                target.step_id,
                target.family.value,
                request.order.value,
            ),
            run_id=target.run_id,
            step_id=target.step_id,
            role=ModelCallRole(request.spec.role.value),
            activity=ACTIVITY_BY_FAMILY[target.family],
            model=call.model,
            effort=request.spec.effort,
            input_tokens=call.input_tokens,
            output_tokens=call.output_tokens,
            cost_usd=call.cost_usd,
            latency_ms=latency_ms,
            status=ModelCallStatus.invalid_output if invalid else ModelCallStatus.ok,
        )

    async def record_failed_call(
        self, request: JudgeStepInput, target: CallTarget, started: float
    ) -> None:
        await self.dependencies.recorder.record(
            ModelCallRecord(
                id=new_id(),
                run_id=target.run_id,
                step_id=target.step_id,
                role=ModelCallRole(request.spec.role.value),
                activity=ACTIVITY_BY_FAMILY[target.family],
                model=self.model_label(request),
                effort=request.spec.effort,
                input_tokens=0,
                output_tokens=0,
                cost_usd=0.0,
                latency_ms=elapsed_ms(started),
                status=ModelCallStatus.error,
            )
        )

    def check_request(self, request: JudgeStepInput, family: JudgeFamily) -> None:
        if request.spec.role is not ROLE_BY_FAMILY[family]:
            raise permanent_error(
                GradingErrorType.role_mismatch,
                f"the {family.value} judge needs a {ROLE_BY_FAMILY[family].value} spec, "
                f"got {request.spec.role.value}",
            )
        if not self.stub_mode and request.spec.model == STUB_MODEL_ID:
            raise permanent_error(
                GradingErrorType.stub_model_mismatch,
                "the run was planned with stub models but TESSA_STUB_MODELS is off here",
            )

    async def replay(
        self, session: AsyncSession, request: JudgeStepInput, target: CallTarget
    ) -> JudgeStepOutput | None:
        if target.paired_id is not None:
            return await replay_swapped_call(session, target.paired_id, request.order)
        return await replay_first_call(session, target.result_id, request.order)

    async def obtain_reply(
        self,
        request: JudgeStepInput,
        family: JudgeFamily,
        prompt: RenderedPrompt,
        target: CallTarget,
    ) -> ProviderReply:
        if self.stub_mode:
            return self.stub_reply(request)
        timeout = call_timeout_seconds(request)
        async with self.dependencies.providers.open(family, timeout) as provider:
            if provider is None:
                raise missing_key_error(family)
            judge_request = JudgeRequest(
                spec=request.spec,
                instructions=prompt.instructions,
                input_text=prompt.input_text,
                timeout_seconds=timeout,
            )
            started = time.monotonic()
            try:
                async with asyncio.timeout(timeout):
                    return await provider.judge(judge_request)
            except ProviderCallError as error:
                await self.record_failed_call(request, target, started)
                raise application_error_of(error) from None
            except TimeoutError:
                await self.record_failed_call(request, target, started)
                raise retryable_error(
                    GradingErrorType.provider_unavailable, f"{family.value} timed out"
                ) from None

    def stub_reply(self, request: JudgeStepInput) -> ProviderReply:
        call = StubCall(role=request.spec.role, spec=request.spec, payload=request)
        try:
            return ProviderReply(text=self.dependencies.stubs.reply(call), usage=TokenUsage(0, 0))
        except StubRoleNotRegisteredError as error:
            raise permanent_error(GradingErrorType.stub_not_registered, str(error)) from None

    def charge(self, request: JudgeStepInput, reply: ProviderReply) -> Charge:
        if self.stub_mode:
            return stub_charge(self.dependencies.price_table)
        return charge_for(
            request.spec.model, reply.usage, request.spec.max_usd, self.dependencies.price_table
        )

    def call_record(
        self,
        request: JudgeStepInput,
        interpretation: Interpretation,
        reply: ProviderReply,
        charge: Charge,
    ) -> JudgeCallRecord:
        verdict = interpretation.verdict
        usage = reply.usage
        return JudgeCallRecord(
            order=request.order,
            model=STUB_MODEL_ID if self.stub_mode else request.spec.model,
            basis=charge.basis.value,
            cost_usd=charge.cost_usd,
            input_tokens=usage.input_tokens if usage is not None else 0,
            output_tokens=usage.output_tokens if usage is not None else 0,
            verdict=stamped_as_stub(verdict) if self.stub_mode else verdict,
            rationale=interpretation.rationale,
            evidence=interpretation.evidence,
        )

    async def persist(
        self, request: JudgeStepInput, target: CallTarget, call: JudgeCallRecord, charge: Charge
    ) -> JudgeStepOutput:
        async with self.dependencies.session_factory() as session:
            if target.paired_id is not None:
                return await complete_pair(
                    session, target.paired_id, target.step_id, call, self.stub_mode
                )
            new = NewJudgeResult(
                id=target.result_id,
                step_id=target.step_id,
                run_id=target.run_id,
                family=target.family,
                model=call.model,
                effort=request.spec.effort,
                rubric_version=rubric_version_of(request.evidence.rubric),
                verdict=call.verdict,
                call=call,
                price_table_version=charge.price_table_version,
            )
            if await insert_first_call(session, new):
                return output_of_new(new)
            replayed = await replay_first_call(session, new.id, request.order)
        return replayed if replayed is not None else output_of_new(new)

    def log_call(
        self, request: JudgeStepInput, target: CallTarget, call: JudgeCallRecord, charge: Charge
    ) -> None:
        logger.info(
            "judge_call",
            extra={
                "step_id": str(target.step_id),
                "family": target.family.value,
                "model": call.model,
                "order": request.order.value,
                "verdict": call.verdict.status.value,
                "cost_usd": call.cost_usd,
                "basis": charge.basis.value,
                "price_table_version": charge.price_table_version,
                "input_tokens": call.input_tokens,
                "output_tokens": call.output_tokens,
            },
        )
