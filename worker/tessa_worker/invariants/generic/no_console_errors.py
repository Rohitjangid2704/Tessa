from collections.abc import Sequence

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
)
from tessa_api.services.invariants.params import console_allow_patterns
from tessa_worker.invariants.base import EvaluatorBase, clipped
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    ProbeRunner,
)
from tessa_worker.invariants.steps import browser_response

ERROR_LEVEL = "error"
CONSOLE_TEXT_LIMIT = 120


class NoConsoleErrorsEvaluator(EvaluatorBase):
    invariant_id = BuiltInInvariantId.no_console_errors.value
    pack = InvariantPack.generic
    check = InvariantCheck.code

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        allowed = console_allow_patterns(context.params)
        pages = [
            (step, response)
            for step in context.steps
            if (response := browser_response(step)) is not None
        ]
        if not pages:
            return [
                self.skipped(
                    SkipReason.adapter_unsupported,
                    "no browser step ran, so no console was recorded",
                )
            ]
        failing = []
        for step, response in pages:
            errors = [
                message.text
                for message in response.console
                if message.level == ERROR_LEVEL
                and not any(pattern.search(message.text) for pattern in allowed)
            ]
            if errors:
                failing.append(
                    self.failed(
                        f"console error on step {step.index + 1}: "
                        f"{clipped(errors[0], CONSOLE_TEXT_LIMIT)}",
                        step_id=step.step_id,
                    )
                )
        if failing:
            return failing
        return [self.passed(f"{len(pages)} page steps showed no console error")]
