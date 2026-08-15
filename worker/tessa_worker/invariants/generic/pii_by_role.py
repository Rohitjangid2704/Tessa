from collections.abc import Sequence

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
)
from tessa_api.services.invariants.params import PiiRules, declared_pii_rules
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    InvariantStep,
    ProbeRunner,
)
from tessa_worker.invariants.steps import headline, json_key_names, response_texts


def leaked_fields(step: InvariantStep, rules: PiiRules) -> list[str]:
    if not rules.fields:
        return []
    return sorted(rules.fields & json_key_names(step))


def leaked_patterns(step: InvariantStep, rules: PiiRules) -> list[int]:
    texts = response_texts(step)
    return [
        position
        for position, pattern in enumerate(rules.patterns, start=1)
        if any(pattern.search(text) for text in texts)
    ]


class PiiByRoleEvaluator(EvaluatorBase):
    invariant_id = BuiltInInvariantId.pii_by_role.value
    pack = InvariantPack.generic
    check = InvariantCheck.code

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        rules = declared_pii_rules(context.params, context.role)
        if not rules.declared:
            return [
                self.skipped(
                    SkipReason.precondition_failed,
                    f"the bundle declares no personal data fields or patterns for role "
                    f"{context.role}",
                )
            ]
        answered = [step for step in context.steps if step.response is not None]
        if not answered:
            return [
                self.skipped(
                    SkipReason.precondition_failed, "no step kept a response that could be scanned"
                )
            ]
        failing = [
            outcome
            for step in answered
            if (outcome := self.step_failure(context.role, step, rules)) is not None
        ]
        if failing:
            return failing
        return [
            self.passed(
                f"{len(answered)} responses held none of the personal data declared for role "
                f"{context.role}"
            )
        ]

    def step_failure(
        self, role: str, step: InvariantStep, rules: PiiRules
    ) -> InvariantOutcome | None:
        fields = leaked_fields(step, rules)
        patterns = leaked_patterns(step, rules)
        if not fields and not patterns:
            return None
        found = [f"field {name}" for name in fields] + [
            f"pattern {position}" for position in patterns
        ]
        return self.failed(
            f"{headline(step)} showed personal data to role {role}: {', '.join(found[:4])}",
            step_id=step.step_id,
        )
