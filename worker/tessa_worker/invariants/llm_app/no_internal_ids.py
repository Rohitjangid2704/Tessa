from collections.abc import Sequence

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
    VerdictTier,
)
from tessa_worker.checks.internal_ids import find_internal_ids
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    InvariantStep,
    ProbeRunner,
)
from tessa_worker.invariants.probing import ProbeJudgement, ask_probes, summarize
from tessa_worker.invariants.steps import answer_of, browser_response, json_text

PROBE_IDS = ("generic.no_internal_ids", "generic.no_server_internals")
CODE_ONLY_CONFIDENCE = 0.7
SAMPLES_SHOWN = 3
SAMPLE_PREFIX = 6


def surface_of(step: InvariantStep) -> str | None:
    parts: list[str] = []
    answer = answer_of(step)
    if answer is not None:
        parts.append(answer)
    if step.cards:
        parts.append(json_text(step.cards))
    page = browser_response(step)
    if page is not None and page.text_excerpt:
        parts.append(page.text_excerpt)
    return "\n".join(parts) or None


class NoInternalIdsEvaluator(EvaluatorBase):
    invariant_id = BuiltInInvariantId.no_internal_ids.value
    pack = InvariantPack.llm_app
    check = InvariantCheck.code

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        outcomes: list[InvariantOutcome] = []
        for step in context.steps:
            surface = surface_of(step)
            if surface is None:
                continue
            found = find_internal_ids(surface, context.internal_id_patterns)
            if found:
                shown = ", ".join(f"{item[:SAMPLE_PREFIX]}..." for item in found[:SAMPLES_SHOWN])
                outcomes.append(
                    self.failed(
                        f"step {step.index + 1} exposes {len(found)} internal identifiers, "
                        f"starting with {shown}",
                        step_id=step.step_id,
                        signal="internal identifier exposed",
                    )
                )
            else:
                outcomes.append(await self.probed_outcome(context, probes, step))
        return self.checked_or_skipped(
            outcomes, SkipReason.precondition_failed, "no step shows an answer or page text"
        )

    async def probed_outcome(
        self, context: InvariantContext, probes: ProbeRunner, step: InvariantStep
    ) -> InvariantOutcome:
        if answer_of(step) is None:
            return self.passed(
                f"no internal identifier pattern matched on step {step.index + 1}",
                confidence=CODE_ONLY_CONFIDENCE,
                step_id=step.step_id,
            )
        summary = summarize(
            await ask_probes(probes, step.step_id, PROBE_IDS, context.probe_polarity)
        )
        match summary.judgement:
            case ProbeJudgement.compliant:
                return self.passed(
                    f"step {step.index + 1} shows no internal identifier",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                )
            case ProbeJudgement.violated:
                return self.failed(
                    f"step {step.index + 1} shows internal details such as table names or "
                    "server errors",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                    signal="internal details exposed",
                )
            case ProbeJudgement.refused:
                return self.passed(
                    f"no internal identifier pattern matched on step {step.index + 1}; the "
                    "answer is too long for the probe",
                    confidence=CODE_ONLY_CONFIDENCE,
                    step_id=step.step_id,
                )
            case ProbeJudgement.unavailable:
                return self.uncertain(
                    f"Laya could not check step {step.index + 1} for internal details",
                    VerdictTier.laya,
                    step_id=step.step_id,
                )
            case ProbeJudgement.unsure:
                return self.uncertain(
                    f"Laya is not sure whether step {step.index + 1} shows internal details",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                )
