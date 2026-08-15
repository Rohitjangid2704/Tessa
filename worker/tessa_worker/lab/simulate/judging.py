import logging
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from temporalio.exceptions import ApplicationError

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import JudgeFamily, JudgeOrder, VerdictStatus, VerdictTier
from tessa_api.schemas.grading import JudgeStepInput, JudgeStepOutput, ModelCallSpec
from tessa_worker.grading.errors import GradingErrorType
from tessa_worker.grading.escalation import GRADING_UNAVAILABLE
from tessa_worker.grading.evidence import EvidenceLimits, EvidenceSource, build_evidence
from tessa_worker.grading.judge_runner import JudgeRunner
from tessa_worker.lab.simulate.outcomes import CheckOutcome, failed, passed, uncertain
from tessa_worker.lab.simulate.session_record import SessionRecord
from tessa_worker.lab.simulate.steps import settle_judgement_step, upsert_judgement_step
from tessa_worker.lab.simulate.transcripts import judge_transcript
from tessa_worker.verdicts import uncertain_verdict

logger = logging.getLogger("tessa_worker.simulator.judging")

SIMULATION_LIMITS = EvidenceLimits(
    ask_chars=1000, answer_chars=9000, invariant_rule_chars=500, rubric_chars=1500
)
CRITERION_RULE_ID = "success_criterion"
JUDGE_PASSED = "judge_passed"
JUDGE_FAILED = "judge_failed"
JUDGE_UNCERTAIN = "judge_uncertain"
JUDGE_UNAVAILABLE = "judge_unavailable"
JUDGE_BUDGET = "judge_budget_exceeded"
UNAVAILABLE_TEXT_LIMIT = 200
BUDGET_ERROR_TYPE = GradingErrorType.budget_exceeded.value


@dataclass(frozen=True, slots=True)
class CriterionRule:
    id: str
    rule: str


@dataclass(frozen=True, slots=True)
class JudgeUsage:
    cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0

    def plus(self, other: "JudgeUsage") -> "JudgeUsage":
        return JudgeUsage(
            round(self.cost_usd + other.cost_usd, 6),
            self.input_tokens + other.input_tokens,
            self.output_tokens + other.output_tokens,
        )


@dataclass(frozen=True, slots=True)
class JudgedOutcome:
    outcome: CheckOutcome
    usage: JudgeUsage


@dataclass(frozen=True, slots=True)
class JudgeRequest:
    index: int
    label: str
    rubric: str
    rules: Sequence[CriterionRule]


def outcome_of(output: JudgeStepOutput) -> CheckOutcome:
    verdict = output.verdict
    rationale = output.rationale
    if verdict.status is VerdictStatus.pass_:
        return passed(VerdictTier.judge, rationale, JUDGE_PASSED, verdict.confidence)
    if verdict.status is VerdictStatus.fail:
        return failed(VerdictTier.judge, rationale, JUDGE_FAILED)
    return uncertain(VerdictTier.judge, rationale, JUDGE_UNCERTAIN, verdict.confidence)


def unavailable_outcome(error: ApplicationError) -> tuple[CheckOutcome, Verdict]:
    budget = error.type == BUDGET_ERROR_TYPE
    code = JUDGE_BUDGET if budget else JUDGE_UNAVAILABLE
    message = f"the judge was not available: {error}"[:UNAVAILABLE_TEXT_LIMIT]
    verdict = uncertain_verdict(GRADING_UNAVAILABLE, message)
    return uncertain(VerdictTier.judge, message, code), verdict


def usage_of(output: JudgeStepOutput) -> JudgeUsage:
    return JudgeUsage(output.cost_usd, output.input_tokens, output.output_tokens)


class SessionJudge:
    def __init__(
        self, runner: JudgeRunner, session_factory: SessionFactory, spec: ModelCallSpec
    ) -> None:
        self.runner = runner
        self.session_factory = session_factory
        self.spec = spec

    async def judge(self, record: SessionRecord, request: JudgeRequest) -> JudgedOutcome:
        evidence = build_evidence(
            EvidenceSource(
                ask=record.goal_statement,
                answer=judge_transcript(record.transcript, SIMULATION_LIMITS.answer_chars),
                invariants=request.rules,
                rubric=request.rubric,
            ),
            SIMULATION_LIMITS,
        )
        step_id = await self.judgement_step(record, request, evidence.answer or "")
        try:
            output = await self.runner.run(
                JudgeStepInput(
                    step_id=step_id, evidence=evidence, order=JudgeOrder.a_b, spec=self.spec
                ),
                JudgeFamily.openai,
            )
        except ApplicationError as error:
            logger.warning(
                "simulation_judge_unavailable",
                extra={"sim_session_id": str(record.sim_session_id), "error_type": error.type},
            )
            outcome, verdict = unavailable_outcome(error)
            await settle_judgement_step(self.session_factory, step_id, verdict)
            return JudgedOutcome(outcome, JudgeUsage())
        await settle_judgement_step(self.session_factory, step_id, output.verdict)
        return JudgedOutcome(outcome_of(output), usage_of(output))

    async def judgement_step(
        self, record: SessionRecord, request: JudgeRequest, answer: str
    ) -> UUID:
        return await upsert_judgement_step(
            self.session_factory,
            record.run_id,
            record.run_scenario_id,
            record.attempt,
            record.target_turns + request.index,
            record.judgement_adapter,
            request.label,
            record.goal_statement,
            answer,
        )
