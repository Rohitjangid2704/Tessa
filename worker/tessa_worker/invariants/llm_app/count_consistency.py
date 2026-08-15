import re
from collections.abc import Sequence

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
)
from tessa_api.schemas.oracles import GoldPoint
from tessa_api.services.gold_interpolation import contains_with_digit_boundaries
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    InvariantStep,
    ProbeRunner,
)
from tessa_worker.invariants.steps import answer_of

STATED_COUNT = re.compile(r"(?<![\w.,])(\d{1,3})(?!\w|[.,]\d)")
CONFLICT_CONFIDENCE = 0.8
MAX_COUNT = 10**9
STATED_SHOWN = 3


def counted_value(point: GoldPoint) -> int | None:
    value = point.value
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    count = int(value)
    return count if 1 <= count <= MAX_COUNT else None


def counts_of(step: InvariantStep) -> list[tuple[GoldPoint, int]]:
    return [
        (point, count) for point in step.gold_points if (count := counted_value(point)) is not None
    ]


def stated_counts(answer: str) -> list[int]:
    return [int(token) for token in STATED_COUNT.findall(answer)]


class CountConsistencyEvaluator(EvaluatorBase):
    invariant_id = BuiltInInvariantId.count_consistency.value
    pack = InvariantPack.llm_app
    check = InvariantCheck.oracle

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        outcomes: list[InvariantOutcome] = []
        for step in context.steps:
            answer = answer_of(step)
            counts = counts_of(step)
            if answer is not None and counts:
                outcomes.append(self.judged(step, answer, counts))
        return self.checked_or_skipped(
            outcomes,
            SkipReason.precondition_failed,
            "no answered step carries a count computed by an oracle",
        )

    def judged(
        self, step: InvariantStep, answer: str, counts: Sequence[tuple[GoldPoint, int]]
    ) -> InvariantOutcome:
        position = step.index + 1
        missing = [
            (point, count)
            for point, count in counts
            if not contains_with_digit_boundaries(answer, point.rendered)
        ]
        if not missing:
            return self.passed(
                f"step {position} states every count the oracle computed ({len(counts)})",
                step_id=step.step_id,
            )
        point, count = missing[0]
        stated = [number for number in stated_counts(answer) if number != count]
        if not stated:
            return self.uncertain(
                f"step {position} does not state the count {point.key} ({count}) in digits",
                step_id=step.step_id,
            )
        shown = ", ".join(str(number) for number in dict.fromkeys(stated[:STATED_SHOWN]))
        return self.failed(
            f"step {position} states {shown} but the oracle counted {count} for {point.key}",
            confidence=CONFLICT_CONFIDENCE,
            step_id=step.step_id,
            signal=f"count mismatch {point.key}",
        )
