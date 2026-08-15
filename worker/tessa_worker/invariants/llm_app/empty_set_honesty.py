from collections.abc import Mapping, Sequence
from uuid import UUID

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
    VerdictTier,
)
from tessa_api.schemas.oracles import GoldPoint
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    InvariantStep,
    ProbeRunner,
)
from tessa_worker.invariants.probing import ProbeJudgement, ask_probes, summarize
from tessa_worker.invariants.steps import answer_of

PROBE_IDS = ("generic.empty_set_honesty",)


def is_empty_value(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int | float):
        return value == 0
    return value == [] or value == ""


def finds_nothing(point: GoldPoint, row_counts: Mapping[UUID, int]) -> bool:
    return row_counts.get(point.oracle_result_id) == 0 or is_empty_value(point.value)


def empty_set_steps(context: InvariantContext) -> list[InvariantStep]:
    return [
        step
        for step in context.steps
        if answer_of(step) is not None
        and any(finds_nothing(point, step.oracle_row_counts) for point in step.gold_points)
    ]


class EmptySetHonestyEvaluator(EvaluatorBase):
    invariant_id = BuiltInInvariantId.empty_set_honesty.value
    pack = InvariantPack.llm_app
    check = InvariantCheck.oracle

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        steps = empty_set_steps(context)
        if not steps:
            return [
                self.skipped(
                    SkipReason.precondition_failed,
                    "no answered step has an oracle result that found nothing",
                )
            ]
        outcomes: list[InvariantOutcome] = []
        unchecked = 0
        for step in steps:
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
        position = step.index + 1
        summary = summarize(
            await ask_probes(probes, step.step_id, PROBE_IDS, context.probe_polarity)
        )
        match summary.judgement:
            case ProbeJudgement.compliant:
                return self.passed(
                    f"step {position} says plainly that the oracle found nothing",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                )
            case ProbeJudgement.violated:
                return self.failed(
                    f"step {position} does not say plainly that nothing was found or invents "
                    "items while the oracle found none",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                    signal="empty set not stated honestly",
                )
            case ProbeJudgement.refused:
                return None
            case ProbeJudgement.unavailable:
                return self.uncertain(
                    f"Laya could not check the answer of step {position} against the empty set",
                    VerdictTier.laya,
                    step_id=step.step_id,
                )
            case ProbeJudgement.unsure:
                return self.uncertain(
                    f"Laya is not sure step {position} reports the empty set honestly",
                    VerdictTier.laya,
                    summary.confidence,
                    step.step_id,
                )
