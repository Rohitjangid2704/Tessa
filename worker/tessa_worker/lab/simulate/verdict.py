from collections.abc import Sequence
from dataclasses import dataclass

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import SimCheck, VerdictStatus, VerdictTier
from tessa_api.schemas.sim import SimChecks
from tessa_api.services.verdict_rollup import clip_reason
from tessa_worker.lab.simulate.outcomes import (
    CheckOutcome,
    lowest_confidence,
    strongest_tier,
)

DECISIVE_ORDER = (SimCheck.end_state, SimCheck.calls, SimCheck.invariants, SimCheck.goal)
NOTHING_VERIFIED = "sim_nothing_verified"
DIALOGUE_CONCERN = "sim_dialogue_concern"
SESSION_PASSED = "sim_passed"


@dataclass(frozen=True, slots=True)
class CheckOutcomes:
    end_state: CheckOutcome
    calls: CheckOutcome
    invariants: CheckOutcome
    goal: CheckOutcome
    dialogue: CheckOutcome

    def of(self, check: SimCheck) -> CheckOutcome:
        match check:
            case SimCheck.end_state:
                return self.end_state
            case SimCheck.calls:
                return self.calls
            case SimCheck.invariants:
                return self.invariants
            case SimCheck.goal:
                return self.goal
            case SimCheck.dialogue:
                return self.dialogue

    def statuses(self) -> SimChecks:
        return SimChecks(
            end_state=self.end_state.status,
            calls=self.calls.status,
            invariants=self.invariants.status,
            goal=self.goal.status,
            dialogue=self.dialogue.status,
        )

    def decisive(self) -> list[tuple[SimCheck, CheckOutcome]]:
        return [(check, self.of(check)) for check in DECISIVE_ORDER]


def verdict_of(
    status: VerdictStatus,
    tier: VerdictTier,
    confidence: float | None,
    reason_code: str,
    reason: str | None,
) -> Verdict:
    return Verdict(
        status=status,
        tier=tier,
        confidence=confidence,
        reason_code=reason_code,
        reason=clip_reason(reason),
        skip_reason=None,
    )


def described(check: SimCheck, outcome: CheckOutcome) -> str:
    return f"{check.value}: {outcome.message}"


def first_decisive(
    decisive: Sequence[tuple[SimCheck, CheckOutcome]], status: VerdictStatus
) -> tuple[SimCheck, CheckOutcome] | None:
    return next(((check, outcome) for check, outcome in decisive if outcome.status is status), None)


def combine_checks(outcomes: CheckOutcomes) -> Verdict:
    decisive = outcomes.decisive()
    failing = first_decisive(decisive, VerdictStatus.fail)
    if failing is not None:
        check, outcome = failing
        return verdict_of(
            VerdictStatus.fail,
            outcome.tier,
            outcome.confidence,
            f"sim_{check.value}_failed",
            described(check, outcome),
        )
    doubtful = first_decisive(decisive, VerdictStatus.uncertain)
    if doubtful is not None:
        check, outcome = doubtful
        return verdict_of(
            VerdictStatus.uncertain,
            outcome.tier,
            outcome.confidence,
            f"sim_{check.value}_uncertain",
            described(check, outcome),
        )
    holding = [outcome for _, outcome in decisive if outcome.status is VerdictStatus.pass_]
    if not holding:
        return verdict_of(
            VerdictStatus.uncertain,
            VerdictTier.code,
            None,
            NOTHING_VERIFIED,
            "no check could verify the session",
        )
    if outcomes.dialogue.status in (VerdictStatus.fail, VerdictStatus.uncertain):
        return verdict_of(
            VerdictStatus.uncertain,
            VerdictTier.judge,
            outcomes.dialogue.confidence,
            DIALOGUE_CONCERN,
            described(SimCheck.dialogue, outcomes.dialogue),
        )
    return verdict_of(
        VerdictStatus.pass_,
        strongest_tier(holding),
        lowest_confidence(holding),
        SESSION_PASSED,
        None,
    )
