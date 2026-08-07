from collections.abc import Mapping, Sequence

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import VerdictStatus, VerdictTier

SCENARIO_TIMEOUT = "scenario_timeout"
ATTEMPT_ERRORED = "attempt_errored"
ATTEMPTS_DISAGREE = "attempts_disagree"
ATTEMPTS_UNCERTAIN = "attempts_uncertain"
NO_ATTEMPTS = "no_attempts"
REASON_LIMIT = 300
FULL_CONFIDENCE = 1.0

ATTEMPT_LEVEL_REASON_CODES = frozenset({SCENARIO_TIMEOUT, ATTEMPT_ERRORED})
STEP_SEVERITY: Mapping[VerdictStatus, int] = {
    VerdictStatus.pass_: 0,
    VerdictStatus.uncertain: 1,
    VerdictStatus.fail: 2,
}


def clip_reason(reason: str | None) -> str | None:
    if reason is None or len(reason) <= REASON_LIMIT:
        return reason
    return reason[: REASON_LIMIT - 3] + "..."


def confidence_or_full(verdict: Verdict) -> float:
    return FULL_CONFIDENCE if verdict.confidence is None else verdict.confidence


def step_rollup(verdicts: Sequence[Verdict]) -> Verdict | None:
    graded = [verdict for verdict in verdicts if verdict.status in STEP_SEVERITY]
    if not graded:
        return None
    worst = max(STEP_SEVERITY[verdict.status] for verdict in graded)
    candidates = [verdict for verdict in graded if STEP_SEVERITY[verdict.status] == worst]
    if worst > STEP_SEVERITY[VerdictStatus.pass_]:
        return candidates[0]
    return min(candidates, key=confidence_or_full)


def refreshed_attempt_verdict(
    stored: Verdict | None, before: Sequence[Verdict], after: Sequence[Verdict]
) -> Verdict | None:
    if stored is None or stored.reason_code in ATTEMPT_LEVEL_REASON_CODES:
        return stored
    stored_severity = STEP_SEVERITY.get(stored.status)
    rolled_after = step_rollup(after)
    if stored_severity is None or rolled_after is None:
        return stored
    rolled_before = step_rollup(before)
    if rolled_before is not None and rolled_before.status is stored.status:
        return rolled_after
    if STEP_SEVERITY[rolled_after.status] > stored_severity:
        return rolled_after
    return stored


def first_with_status(verdicts: Sequence[Verdict], status: VerdictStatus) -> Verdict:
    return next(verdict for verdict in verdicts if verdict.status is status)


def uncertain_attempts_verdict(reason_code: str, reason: str | None) -> Verdict:
    return Verdict(
        status=VerdictStatus.uncertain,
        tier=VerdictTier.code,
        confidence=None,
        reason_code=reason_code,
        reason=clip_reason(reason),
        skip_reason=None,
    )


def aggregate_attempt_verdicts(verdicts: Sequence[Verdict]) -> Verdict:
    if not verdicts:
        return uncertain_attempts_verdict(NO_ATTEMPTS, "no attempt produced a verdict")
    statuses = {verdict.status for verdict in verdicts}
    if len(statuses) == 1:
        return verdicts[0]
    passed = sum(verdict.status is VerdictStatus.pass_ for verdict in verdicts)
    if {VerdictStatus.pass_, VerdictStatus.fail} <= statuses:
        return Verdict(
            status=VerdictStatus.flaky,
            tier=VerdictTier.code,
            confidence=None,
            reason_code=ATTEMPTS_DISAGREE,
            reason=f"{passed} of {len(verdicts)} attempts passed",
            skip_reason=None,
        )
    if VerdictStatus.fail in statuses:
        return first_with_status(verdicts, VerdictStatus.fail)
    if VerdictStatus.uncertain in statuses:
        return uncertain_attempts_verdict(
            ATTEMPTS_UNCERTAIN,
            first_with_status(verdicts, VerdictStatus.uncertain).reason
            or "at least one attempt was uncertain",
        )
    return first_with_status(verdicts, VerdictStatus.pass_)
