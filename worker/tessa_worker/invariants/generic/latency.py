from collections.abc import Sequence

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
)
from tessa_api.schemas.steps import SseStepResponse
from tessa_api.services.invariants.params import latency_limit_ms
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    InvariantStep,
    ProbeRunner,
)
from tessa_worker.invariants.steps import headline

RESPONSE_TIME = "response time"
FIRST_EVENT_TIME = "time to the first event"


def measurement(step: InvariantStep) -> tuple[int, str]:
    response = step.response
    if isinstance(response, SseStepResponse) and response.events:
        return response.events[0].at_ms, FIRST_EVENT_TIME
    return step.latency_ms, RESPONSE_TIME


class LatencyEvaluator(EvaluatorBase):
    invariant_id = BuiltInInvariantId.latency.value
    pack = InvariantPack.generic
    check = InvariantCheck.code

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        limit = latency_limit_ms(context.params) or context.latency_default_ms
        measured = [(step, *measurement(step)) for step in context.steps if step.ok is not False]
        if not measured:
            return [
                self.skipped(
                    SkipReason.precondition_failed,
                    "no step completed, so no latency could be measured",
                )
            ]
        slow = [
            self.failed(
                f"{headline(step)} {what} was {milliseconds} ms, the limit is {limit} ms",
                step_id=step.step_id,
            )
            for step, milliseconds, what in measured
            if milliseconds > limit
        ]
        if slow:
            return slow
        slowest = max(milliseconds for _, milliseconds, _ in measured)
        return [
            self.passed(
                f"{len(measured)} steps were measured, the slowest took {slowest} ms "
                f"(limit {limit} ms)"
            )
        ]
