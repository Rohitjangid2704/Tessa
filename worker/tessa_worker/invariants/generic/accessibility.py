from collections.abc import Sequence

from pydantic import ValidationError

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
)
from tessa_api.schemas.steps import BrowserStepResponse
from tessa_api.services.invariants.params import string_items
from tessa_worker.adapters.accessibility import ACCESSIBILITY_KEY, AccessibilityCapture
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    InvariantStep,
    ProbeRunner,
)
from tessa_worker.invariants.steps import browser_response

FAIL_ON_KEY = "fail_on"
DEFAULT_FAIL_ON = frozenset({"serious", "critical"})
RULES_SHOWN = 3


def blocking_impacts(context: InvariantContext) -> frozenset[str]:
    declared = {item.casefold() for item in string_items(context.params.get(FAIL_ON_KEY))}
    return frozenset(declared) or DEFAULT_FAIL_ON


def capture_of(response: BrowserStepResponse) -> AccessibilityCapture | None:
    raw = (response.model_extra or {}).get(ACCESSIBILITY_KEY)
    if raw is None:
        return None
    try:
        return AccessibilityCapture.model_validate(raw)
    except ValidationError:
        return None


class AccessibilityEvaluator(EvaluatorBase):
    invariant_id = BuiltInInvariantId.accessibility.value
    pack = InvariantPack.generic
    check = InvariantCheck.code

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        blocking = blocking_impacts(context)
        pages = [
            (step, response)
            for step in context.steps
            if (response := browser_response(step)) is not None
        ]
        if not pages:
            return [
                self.skipped(
                    SkipReason.adapter_unsupported,
                    "no browser step ran, so no page was scanned",
                )
            ]
        captures = [
            (step, capture)
            for step, response in pages
            if (capture := capture_of(response)) is not None
        ]
        if not captures:
            return [
                self.skipped(
                    SkipReason.precondition_failed,
                    "the browser steps carry no axe-core result, the scan did not run",
                )
            ]
        failing = [
            outcome
            for step, capture in captures
            if (outcome := self.page_failure(step, capture, blocking)) is not None
        ]
        if failing:
            return failing
        return [
            self.passed(
                f"axe-core found no {'/'.join(sorted(blocking))} violation on "
                f"{len(captures)} scanned pages"
            )
        ]

    def page_failure(
        self, step: InvariantStep, capture: AccessibilityCapture, blocking: frozenset[str]
    ) -> InvariantOutcome | None:
        serious = [item for item in capture.violations if (item.impact or "") in blocking]
        if not serious:
            return None
        rules = ", ".join(item.id for item in serious[:RULES_SHOWN])
        return self.failed(
            f"{len(serious)} accessibility rules fail on step {step.index + 1}: {rules}",
            step_id=step.step_id,
            signal=f"accessibility {rules}",
        )
