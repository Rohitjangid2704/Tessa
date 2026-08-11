import uuid
from datetime import UTC, datetime

import pytest

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import InvariantPack, SkipReason, VerdictStatus, VerdictTier
from tessa_api.schemas.invariants import InvariantResult
from tessa_api.services.verdict_rollup import (
    ATTEMPTS_DISAGREE,
    ATTEMPTS_UNCERTAIN,
    NO_ATTEMPTS,
    REASON_LIMIT,
)
from tessa_api.services.verdicts import (
    INVARIANT_FAILED,
    INVARIANT_UNCERTAIN,
    across_attempts_status,
    attempt_verdict,
    deciding_invariant_verdicts,
    passes_all_attempts,
    scenario_verdict,
    within_attempt_status,
    worst_verdict,
)

PASS = VerdictStatus.pass_
FAIL = VerdictStatus.fail
FLAKY = VerdictStatus.flaky
UNCERTAIN = VerdictStatus.uncertain
SKIPPED = VerdictStatus.skipped


def verdict(
    status: VerdictStatus,
    confidence: float | None = None,
    reason_code: str | None = None,
    tier: VerdictTier = VerdictTier.code,
) -> Verdict:
    return Verdict(
        status=status,
        tier=tier,
        confidence=confidence,
        reason_code=reason_code or status.value,
        reason=f"{status.value} reason",
        skip_reason=SkipReason.precondition_failed if status is SKIPPED else None,
    )


def invariant_result(
    status: VerdictStatus, invariant_id: str = "no_5xx", message: str = "a 500 came back"
) -> InvariantResult:
    return InvariantResult(
        id=uuid.uuid4(),
        run_id=uuid.uuid4(),
        run_scenario_id=uuid.uuid4(),
        step_id=None,
        attempt=0,
        invariant_id=invariant_id,
        pack=InvariantPack.generic,
        status=status,
        tier=VerdictTier.code,
        confidence=0.9 if status is not SKIPPED else None,
        message=message,
        skip_reason=SkipReason.precondition_failed if status is SKIPPED else None,
        created_at=datetime.now(UTC),
    )


def test_the_worst_verdict_ranks_fail_over_uncertain_over_skipped_over_pass() -> None:
    ladder = [verdict(PASS), verdict(SKIPPED), verdict(UNCERTAIN), verdict(FAIL)]
    for cut in range(1, len(ladder) + 1):
        worst = worst_verdict(ladder[:cut])
        assert worst is not None
        assert worst.status is ladder[cut - 1].status
    assert worst_verdict(list(reversed(ladder))) == ladder[-1]


def test_among_failures_the_first_one_decides_and_among_passes_the_least_confident() -> None:
    first_fail = verdict(FAIL, reason_code="first")
    second_fail = verdict(FAIL, reason_code="second")
    assert worst_verdict([verdict(PASS), first_fail, second_fail]) is first_fail
    sure = verdict(PASS, confidence=0.99)
    shaky = verdict(PASS, confidence=0.61)
    unscored = verdict(PASS, confidence=None)
    assert worst_verdict([sure, unscored, shaky]) is shaky


def test_a_flaky_verdict_is_not_ranked_within_an_attempt() -> None:
    assert worst_verdict([verdict(FLAKY)]) is None
    assert worst_verdict([]) is None


def test_an_uncertain_step_keeps_the_attempt_from_passing() -> None:
    drive = verdict(PASS, confidence=1.0)
    result = attempt_verdict(drive, [verdict(PASS), verdict(UNCERTAIN)], [])
    assert result.status is UNCERTAIN


def test_a_failed_invariant_fails_an_attempt_whose_steps_all_passed() -> None:
    drive = verdict(PASS)
    invariants = deciding_invariant_verdicts([invariant_result(FAIL)])
    result = attempt_verdict(drive, [verdict(PASS), verdict(PASS)], invariants)
    assert result.status is FAIL
    assert result.reason_code == INVARIANT_FAILED


def test_the_drive_verdict_stands_when_nothing_else_is_ranked() -> None:
    drive = verdict(FLAKY)
    assert attempt_verdict(drive, [], []) is drive
    passing_drive = verdict(PASS)
    assert attempt_verdict(passing_drive, [], []) is passing_drive


def test_only_failed_and_uncertain_invariants_decide_and_their_reason_is_clipped() -> None:
    long_message = "x" * (REASON_LIMIT * 2)
    results = [
        invariant_result(PASS),
        invariant_result(SKIPPED),
        invariant_result(FAIL, "no_5xx", "a 500 came back"),
        invariant_result(UNCERTAIN, "refuses_out_of_scope", long_message),
    ]
    deciding = deciding_invariant_verdicts(results)
    assert [item.status for item in deciding] == [FAIL, UNCERTAIN]
    assert [item.reason_code for item in deciding] == [INVARIANT_FAILED, INVARIANT_UNCERTAIN]
    assert deciding[0].reason == "no_5xx: a 500 came back"
    assert deciding[1].reason is not None
    assert len(deciding[1].reason) == REASON_LIMIT
    assert deciding[1].reason.endswith("...")
    assert all(item.skip_reason is None for item in deciding)


@pytest.mark.parametrize("status", [PASS, FAIL, UNCERTAIN, SKIPPED])
def test_attempts_that_agree_give_their_own_verdict(status: VerdictStatus) -> None:
    attempts = [verdict(status), verdict(status), verdict(status)]
    assert scenario_verdict(attempts) is attempts[0]


def test_a_pass_and_a_fail_across_attempts_is_flaky_with_the_pass_count() -> None:
    result = scenario_verdict([verdict(PASS), verdict(FAIL), verdict(PASS)])
    assert result.status is FLAKY
    assert result.reason_code == ATTEMPTS_DISAGREE
    assert result.reason == "2 of 3 attempts passed"
    assert result.confidence is None


def test_an_uncertain_attempt_is_never_rolled_up_into_a_pass() -> None:
    result = scenario_verdict([verdict(PASS), verdict(PASS), verdict(UNCERTAIN)])
    assert result.status is UNCERTAIN
    assert result.reason_code == ATTEMPTS_UNCERTAIN
    assert result.reason == "uncertain reason"


def test_a_failed_attempt_beats_an_uncertain_one_without_a_pass() -> None:
    failing = verdict(FAIL)
    assert scenario_verdict([verdict(UNCERTAIN), failing]) is failing


def test_no_attempt_is_uncertain_not_a_pass() -> None:
    result = scenario_verdict([])
    assert result.status is UNCERTAIN
    assert result.reason_code == NO_ATTEMPTS


def test_pass_to_the_k_needs_every_planned_attempt_to_pass() -> None:
    assert passes_all_attempts([verdict(PASS)] * 3, 3)
    assert not passes_all_attempts([verdict(PASS)] * 2, 3)
    assert not passes_all_attempts([verdict(PASS), None, verdict(PASS)], 3)
    assert not passes_all_attempts([verdict(PASS), verdict(UNCERTAIN), verdict(PASS)], 3)
    assert not passes_all_attempts([verdict(PASS), verdict(FLAKY), verdict(PASS)], 3)
    assert not passes_all_attempts([], 0)


def test_within_an_attempt_flaky_then_fail_then_uncertain_then_pass_decide() -> None:
    assert within_attempt_status([]) is UNCERTAIN
    assert within_attempt_status([PASS, FAIL, FLAKY]) is FLAKY
    assert within_attempt_status([PASS, UNCERTAIN, FAIL]) is FAIL
    assert within_attempt_status([PASS, UNCERTAIN, SKIPPED]) is UNCERTAIN
    assert within_attempt_status([PASS, SKIPPED]) is PASS
    assert within_attempt_status([SKIPPED]) is SKIPPED


def test_across_attempts_a_pass_and_a_fail_are_flaky_and_uncertain_is_never_a_pass() -> None:
    assert across_attempts_status([PASS, FAIL]) is FLAKY
    assert across_attempts_status([PASS, PASS, UNCERTAIN]) is UNCERTAIN
    assert across_attempts_status([PASS, PASS]) is PASS
    assert across_attempts_status([FAIL, UNCERTAIN]) is FAIL
    assert across_attempts_status([]) is UNCERTAIN
