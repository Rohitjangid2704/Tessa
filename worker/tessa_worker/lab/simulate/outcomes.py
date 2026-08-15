from collections.abc import Sequence
from dataclasses import dataclass

from tessa_api.schemas.enums import VerdictStatus, VerdictTier

CRITERIA_SKIPPED = "criteria_skipped"
ALL_CRITERIA_HOLD = "criteria_hold"
NO_CRITERIA = "no_success_criteria"
FIRST_MESSAGE_LIMIT = 200


@dataclass(frozen=True, slots=True)
class CheckOutcome:
    status: VerdictStatus
    tier: VerdictTier
    message: str
    reason_code: str
    confidence: float | None = None


def passed(
    tier: VerdictTier, message: str, reason_code: str, confidence: float | None = None
) -> CheckOutcome:
    return CheckOutcome(VerdictStatus.pass_, tier, message, reason_code, confidence)


def failed(tier: VerdictTier, message: str, reason_code: str) -> CheckOutcome:
    return CheckOutcome(VerdictStatus.fail, tier, message, reason_code, 1.0)


def uncertain(
    tier: VerdictTier, message: str, reason_code: str, confidence: float | None = None
) -> CheckOutcome:
    return CheckOutcome(VerdictStatus.uncertain, tier, message, reason_code, confidence)


def skipped(message: str, reason_code: str) -> CheckOutcome:
    return CheckOutcome(VerdictStatus.skipped, VerdictTier.code, message, reason_code)


def first_with(outcomes: Sequence[CheckOutcome], status: VerdictStatus) -> CheckOutcome | None:
    return next((outcome for outcome in outcomes if outcome.status is status), None)


def strongest_tier(outcomes: Sequence[CheckOutcome]) -> VerdictTier:
    if any(outcome.tier is VerdictTier.judge for outcome in outcomes):
        return VerdictTier.judge
    return VerdictTier.code


def lowest_confidence(outcomes: Sequence[CheckOutcome]) -> float | None:
    known = [outcome.confidence for outcome in outcomes if outcome.confidence is not None]
    return min(known) if known else None


def merge_outcomes(outcomes: Sequence[CheckOutcome], when_empty: CheckOutcome) -> CheckOutcome:
    if not outcomes:
        return when_empty
    for status in (VerdictStatus.fail, VerdictStatus.uncertain):
        found = first_with(outcomes, status)
        if found is not None:
            return found
    decided = [outcome for outcome in outcomes if outcome.status is VerdictStatus.pass_]
    unchecked = [outcome for outcome in outcomes if outcome.status is VerdictStatus.skipped]
    if not decided:
        return skipped(unchecked[0].message, unchecked[0].reason_code)
    if unchecked:
        return uncertain(
            strongest_tier(decided),
            f"{len(unchecked)} of {len(outcomes)} criteria could not be checked: "
            f"{unchecked[0].message}"[:FIRST_MESSAGE_LIMIT],
            CRITERIA_SKIPPED,
            lowest_confidence(decided),
        )
    return passed(
        strongest_tier(decided),
        f"all {len(decided)} criteria hold",
        ALL_CRITERIA_HOLD,
        lowest_confidence(decided),
    )
