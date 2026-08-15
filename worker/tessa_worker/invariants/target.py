from collections.abc import Sequence

from tessa_api.schemas.enums import InvariantCheck, InvariantPack, SkipReason, VerdictTier
from tessa_api.services.probe_specs import TARGET_PROBE_ID_PREFIX
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    InvariantStep,
    ProbeRunner,
)
from tessa_worker.invariants.probing import ProbeJudgement, ask_probes, summarize
from tessa_worker.invariants.steps import answer_of, ask_of

DECLARED_BY_BUNDLE = "the bundle declares"


class TargetInvariantEvaluator(EvaluatorBase):
    pack = InvariantPack.target

    def __init__(self, invariant_id: str, check: InvariantCheck) -> None:
        self.invariant_id = invariant_id
        self.check = check

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        if self.check is not InvariantCheck.probe:
            return [
                self.skipped(
                    SkipReason.precondition_failed,
                    f"{DECLARED_BY_BUNDLE} this rule with check {self.check.value}; Tessa "
                    "has no generic evaluator for it, express it as scenario expectations or an "
                    "oracle",
                )
            ]
        answered = [step for step in context.steps if answer_of(step) is not None and ask_of(step)]
        if not answered:
            return [
                self.skipped(
                    SkipReason.precondition_failed,
                    "no step has both a question and an answer for the rule to be read against",
                )
            ]
        return [await self.judged(context, probes, step) for step in answered]

    async def judged(
        self, context: InvariantContext, probes: ProbeRunner, step: InvariantStep
    ) -> InvariantOutcome:
        position = step.index + 1
        probe_id = f"{TARGET_PROBE_ID_PREFIX}{self.invariant_id}"
        summary = summarize(
            await ask_probes(probes, step.step_id, (probe_id,), context.probe_polarity)
        )
        match summary.judgement:
            case ProbeJudgement.compliant:
                return self.passed(
                    f"step {position} complies with the rule of the bundle",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                )
            case ProbeJudgement.violated:
                return self.failed(
                    f"step {position} breaks the rule of the bundle",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                    signal=f"target rule {self.invariant_id} broken",
                )
            case ProbeJudgement.unsure:
                return self.uncertain(
                    f"Laya is not sure step {position} complies with the rule of the bundle",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                )
            case _:
                return self.uncertain(
                    f"step {position} could not be read against the rule of the bundle",
                    VerdictTier.laya,
                    step_id=step.step_id,
                )
