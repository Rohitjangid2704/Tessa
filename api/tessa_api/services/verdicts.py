from collections.abc import Iterable, Mapping, Sequence

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import VerdictStatus
from tessa_api.schemas.invariants import InvariantResult
from tessa_api.services.verdict_rollup import (
    aggregate_attempt_verdicts,
    clip_reason,
    confidence_or_full,
)

INVARIANT_FAILED = "invariant_failed"
INVARIANT_UNCERTAIN = "invariant_uncertain"
INVARIANTS_UNAVAILABLE = "invariants_unavailable"

ATTEMPT_PRECEDENCE: Mapping[VerdictStatus, int] = {
    VerdictStatus.pass_: 0,
    VerdictStatus.skipped: 1,
    VerdictStatus.uncertain: 2,
    VerdictStatus.fail: 3,
}
INVARIANT_REASON_CODES: Mapping[VerdictStatus, str] = {
    VerdictStatus.fail: INVARIANT_FAILED,
    VerdictStatus.uncertain: INVARIANT_UNCERTAIN,
}


def worst_verdict(verdicts: Sequence[Verdict]) -> Verdict | None:
    ranked = [verdict for verdict in verdicts if verdict.status in ATTEMPT_PRECEDENCE]
    if not ranked:
        return None
    worst = max(ATTEMPT_PRECEDENCE[verdict.status] for verdict in ranked)
    candidates = [verdict for verdict in ranked if ATTEMPT_PRECEDENCE[verdict.status] == worst]
    if worst == ATTEMPT_PRECEDENCE[VerdictStatus.pass_]:
        return min(candidates, key=confidence_or_full)
    return candidates[0]


def deciding_invariant_verdicts(results: Iterable[InvariantResult]) -> list[Verdict]:
    return [
        Verdict(
            status=result.status,
            tier=result.tier,
            confidence=result.confidence,
            reason_code=INVARIANT_REASON_CODES[result.status],
            reason=clip_reason(f"{result.invariant_id}: {result.message}"),
            skip_reason=None,
        )
        for result in results
        if result.status in INVARIANT_REASON_CODES
    ]


def attempt_verdict(
    drive_verdict: Verdict,
    step_verdicts: Sequence[Verdict],
    invariant_verdicts: Sequence[Verdict],
) -> Verdict:
    return worst_verdict([drive_verdict, *step_verdicts, *invariant_verdicts]) or drive_verdict


def scenario_verdict(attempt_verdicts: Sequence[Verdict]) -> Verdict:
    return aggregate_attempt_verdicts(attempt_verdicts)


def passes_all_attempts(attempt_verdicts: Sequence[Verdict | None], planned_attempts: int) -> bool:
    return (
        planned_attempts >= 1
        and len(attempt_verdicts) == planned_attempts
        and all(
            verdict is not None and verdict.status is VerdictStatus.pass_
            for verdict in attempt_verdicts
        )
    )


def within_attempt_status(statuses: Iterable[VerdictStatus]) -> VerdictStatus:
    present = set(statuses)
    if not present:
        return VerdictStatus.uncertain
    if VerdictStatus.flaky in present:
        return VerdictStatus.flaky
    for status in (VerdictStatus.fail, VerdictStatus.uncertain, VerdictStatus.pass_):
        if status in present:
            return status
    return VerdictStatus.skipped


def across_attempts_status(statuses: Iterable[VerdictStatus]) -> VerdictStatus:
    present = set(statuses)
    if {VerdictStatus.pass_, VerdictStatus.fail} <= present:
        return VerdictStatus.flaky
    return within_attempt_status(present)
