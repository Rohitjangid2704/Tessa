from collections import defaultdict
from collections.abc import Sequence

from pydantic import JsonValue

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
    VerdictStatus,
)
from tessa_api.schemas.steps import HttpStepResponse
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    InvariantStep,
    ProbeRunner,
)
from tessa_worker.invariants.steps import headline, idempotency_key_of, response_status

SUCCESS_FROM = 200
SUCCESS_BELOW = 300
CONFLICT_STATUS = 409
IDENTITY_NAMES = frozenset({"id", "uuid", "reference", "ref", "number", "key", "slug"})
IDENTITY_SUFFIXES = ("_id", "_uuid", "_ref", "_number")
MAX_DEPTH = 4
IDENTICAL_CONFIDENCE = 0.8
IDENTITY_CONFIDENCE = 0.9


def is_identity_key(name: str) -> bool:
    lowered = name.casefold()
    return lowered in IDENTITY_NAMES or lowered.endswith(IDENTITY_SUFFIXES)


def identities_of(value: JsonValue, path: str = "", depth: int = 0) -> dict[str, JsonValue]:
    found: dict[str, JsonValue] = {}
    if depth > MAX_DEPTH:
        return found
    if isinstance(value, dict):
        for name, item in value.items():
            where = f"{path}.{name}" if path else name
            if is_identity_key(name) and isinstance(item, str | int) and not isinstance(item, bool):
                found[where] = item
            elif isinstance(item, dict | list):
                found.update(identities_of(item, where, depth + 1))
    elif isinstance(value, list):
        for position, item in enumerate(value[:1]):
            found.update(identities_of(item, f"{path}[{position}]", depth + 1))
    return found


def body_of(step: InvariantStep) -> JsonValue:
    response = step.response
    return response.body if isinstance(response, HttpStepResponse) else None


def succeeded(status: int | None) -> bool:
    return status is not None and SUCCESS_FROM <= status < SUCCESS_BELOW


class IdempotentWritesEvaluator(EvaluatorBase):
    invariant_id = BuiltInInvariantId.idempotent_writes.value
    pack = InvariantPack.generic
    check = InvariantCheck.code

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        groups = self.keyed_groups(context.steps)
        pairs = {key: group for key, group in groups.items() if len(group) >= 2}
        if not pairs:
            return [
                self.skipped(
                    SkipReason.precondition_failed,
                    "no write was repeated under the same idempotency key",
                )
            ]
        outcomes = [self.judged(group) for group in pairs.values()]
        failing = [item for item in outcomes if item.status is VerdictStatus.fail]
        return failing or outcomes

    def keyed_groups(
        self, steps: Sequence[InvariantStep]
    ) -> dict[tuple[int, str], list[InvariantStep]]:
        groups: dict[tuple[int, str], list[InvariantStep]] = defaultdict(list)
        for step in steps:
            key = idempotency_key_of(step)
            if key is not None:
                groups[(step.attempt, key)].append(step)
        return groups

    def judged(self, group: Sequence[InvariantStep]) -> InvariantOutcome:
        first, replay = group[0], group[1]
        first_status, replay_status = response_status(first), response_status(replay)
        label = headline(first)
        if not succeeded(first_status):
            return self.uncertain(
                f"the first {label} did not succeed (status {first_status}), so the replay "
                "proves nothing",
                step_id=first.step_id,
            )
        if replay_status == CONFLICT_STATUS:
            return self.passed(
                f"the replay of {label} was answered as a conflict, no second effect",
                step_id=replay.step_id,
            )
        if not succeeded(replay_status):
            return self.uncertain(
                f"the replay of {label} answered with status {replay_status}",
                step_id=replay.step_id,
            )
        return self.compare_bodies(label, first, replay)

    def compare_bodies(
        self, label: str, first: InvariantStep, replay: InvariantStep
    ) -> InvariantOutcome:
        first_ids, replay_ids = identities_of(body_of(first)), identities_of(body_of(replay))
        shared = sorted(set(first_ids) & set(replay_ids))
        differing = [name for name in shared if first_ids[name] != replay_ids[name]]
        if differing:
            return self.failed(
                f"the replay of {label} created another resource: {', '.join(differing[:3])} "
                "differs from the first response",
                confidence=IDENTITY_CONFIDENCE,
                step_id=replay.step_id,
                signal="replayed write created a second resource",
            )
        if shared:
            return self.passed(
                f"the replay of {label} returned the same {', '.join(shared[:3])}",
                confidence=IDENTITY_CONFIDENCE,
                step_id=replay.step_id,
            )
        if body_of(first) is not None and body_of(first) == body_of(replay):
            return self.passed(
                f"the replay of {label} returned the same response",
                confidence=IDENTICAL_CONFIDENCE,
                step_id=replay.step_id,
            )
        return self.uncertain(
            f"the replay of {label} succeeded but the responses carry no identifier to compare; "
            "a database check can tell whether a second row exists",
            step_id=replay.step_id,
        )
