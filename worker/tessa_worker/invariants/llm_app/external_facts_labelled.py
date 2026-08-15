from collections.abc import Sequence

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
    VerdictTier,
)
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    InvariantStep,
    ProbeRunner,
)
from tessa_worker.invariants.probing import ProbeJudgement, ask_probes, summarize
from tessa_worker.invariants.steps import answer_of

PROBE_IDS = ("generic.external_facts_labelled",)


class ExternalFactsLabelledEvaluator(EvaluatorBase):
    invariant_id = BuiltInInvariantId.external_facts_labelled.value
    pack = InvariantPack.llm_app
    check = InvariantCheck.probe

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        answered = [step for step in context.steps if answer_of(step) is not None]
        if not answered:
            return [self.skipped(SkipReason.precondition_failed, "no step produced an answer text")]
        outcomes: list[InvariantOutcome] = []
        unchecked = 0
        for step in answered:
            outcome = await self.judged(context, probes, step)
            if outcome is None:
                unchecked += 1
            else:
                outcomes.append(outcome)
        return self.checked_or_skipped(
            outcomes,
            SkipReason.precondition_failed,
            f"{unchecked} answers are too long for the probe",
        )

    async def judged(
        self, context: InvariantContext, probes: ProbeRunner, step: InvariantStep
    ) -> InvariantOutcome | None:
        summary = summarize(
            await ask_probes(probes, step.step_id, PROBE_IDS, context.probe_polarity)
        )
        match summary.judgement:
            case ProbeJudgement.compliant:
                return self.passed(
                    f"step {step.index + 1} labels what does not come from the application",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                )
            case ProbeJudgement.violated:
                return self.failed(
                    f"step {step.index + 1} states facts that are neither from the application "
                    "nor marked as general knowledge",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                    signal="unlabelled external facts",
                )
            case ProbeJudgement.refused:
                return None
            case ProbeJudgement.unavailable:
                return self.uncertain(
                    f"Laya could not check the facts of step {step.index + 1}",
                    VerdictTier.laya,
                    step_id=step.step_id,
                )
            case ProbeJudgement.unsure:
                return self.uncertain(
                    f"Laya is not sure the facts of step {step.index + 1} are labelled",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                )
