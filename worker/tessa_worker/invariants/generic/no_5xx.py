from collections.abc import Sequence

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
)
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    ProbeRunner,
)
from tessa_worker.invariants.steps import headline, response_status

SERVER_ERROR_FROM = 500


class No5xxEvaluator(EvaluatorBase):
    invariant_id = BuiltInInvariantId.no_5xx.value
    pack = InvariantPack.generic
    check = InvariantCheck.code

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        answered = [
            (step, status)
            for step in context.steps
            if (status := response_status(step)) is not None
        ]
        if not answered:
            return [
                self.skipped(
                    SkipReason.adapter_unsupported,
                    "no step recorded an HTTP status, so there is nothing to check",
                )
            ]
        failing = [
            self.failed(f"{headline(step)} answered with status {status}", step_id=step.step_id)
            for step, status in answered
            if status >= SERVER_ERROR_FROM
        ]
        if failing:
            return failing
        return [self.passed(f"{len(answered)} responses were recorded and none was a 5xx")]
