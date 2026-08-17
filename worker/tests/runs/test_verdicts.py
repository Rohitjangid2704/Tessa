import pytest

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import RunScenarioStatus, SkipReason, VerdictStatus, VerdictTier
from tessa_worker.verdicts import (
    ATTEMPT_ERRORED,
    ATTEMPTS_DISAGREE,
    ATTEMPTS_UNCERTAIN,
    REASON_LIMIT,
    aggregate_attempt_verdicts,
    clip_reason,
    fail_verdict,
    pass_verdict,
    skipped_verdict,
    uncertain_verdict,
)
from tessa_worker.workflows.run_scenario import AttemptOutcome, summarize_scenario

P, F = pass_verdict(), fail_verdict("status: expected 200, got 500")
U = uncertain_verdict(ATTEMPT_ERRORED, "worker crashed")


def statuses(*verdicts: Verdict) -> list[VerdictStatus]:
    return [verdict.status for verdict in verdicts]


def test_constructors_follow_the_contract_shape() -> None:
    assert (P.status, P.tier, P.confidence, P.skip_reason) == (
        VerdictStatus.pass_,
        VerdictTier.code,
        1.0,
        None,
    )
    assert (F.status, F.confidence, F.reason_code) == (VerdictStatus.fail, 1.0, "tier0_failed")
    assert (U.status, U.confidence, U.reason_code) == (
        VerdictStatus.uncertain,
        None,
        ATTEMPT_ERRORED,
    )
    skipped = skipped_verdict(SkipReason.budget_exceeded)
    assert skipped.status is VerdictStatus.skipped
    assert skipped.skip_reason is SkipReason.budget_exceeded


@pytest.mark.parametrize(
    ("verdicts", "expected"),
    [
        ([P, P, P], VerdictStatus.pass_),
        ([F, F], VerdictStatus.fail),
        ([P, F, P], VerdictStatus.flaky),
        ([F, P], VerdictStatus.flaky),
        ([P, F, U], VerdictStatus.flaky),
        ([P, U], VerdictStatus.uncertain),
        ([F, U], VerdictStatus.fail),
        ([U, U], VerdictStatus.uncertain),
    ],
)
def test_attempt_verdicts_aggregate_by_the_contract_rules(
    verdicts: list[Verdict], expected: VerdictStatus
) -> None:
    assert aggregate_attempt_verdicts(verdicts).status is expected


def test_a_mix_of_pass_and_fail_reports_how_many_attempts_passed() -> None:
    flaky = aggregate_attempt_verdicts([P, F, P])
    assert flaky.reason_code == ATTEMPTS_DISAGREE
    assert flaky.reason == "2 of 3 attempts passed"
    assert flaky.confidence is None


def test_uncertain_is_never_turned_into_a_pass() -> None:
    mixed = aggregate_attempt_verdicts([P, U])
    assert mixed.status is VerdictStatus.uncertain
    assert mixed.reason_code == ATTEMPTS_UNCERTAIN
    assert mixed.reason == "worker crashed"


def test_a_single_status_keeps_the_original_verdict() -> None:
    assert aggregate_attempt_verdicts([F, F]) == F
    assert aggregate_attempt_verdicts([U]) == U


def test_no_verdicts_is_uncertain() -> None:
    assert aggregate_attempt_verdicts([]).status is VerdictStatus.uncertain


def test_long_reasons_are_clipped() -> None:
    clipped = clip_reason("x" * 1000)
    assert clipped is not None
    assert len(clipped) == REASON_LIMIT
    assert clipped.endswith("...")
    assert clip_reason(None) is None


def outcome(attempt: int, status: RunScenarioStatus, verdict: Verdict | None) -> AttemptOutcome:
    return AttemptOutcome(attempt, status, verdict)


def test_a_scenario_that_finished_all_attempts_is_finished_with_the_aggregate() -> None:
    status, verdict = summarize_scenario(
        [
            outcome(0, RunScenarioStatus.finished, P),
            outcome(1, RunScenarioStatus.finished, F),
        ],
        2,
        None,
    )
    assert status is RunScenarioStatus.finished
    assert verdict.status is VerdictStatus.flaky


def test_a_scenario_whose_attempts_all_errored_is_errored_and_uncertain() -> None:
    status, verdict = summarize_scenario([outcome(0, RunScenarioStatus.errored, U)], 1, None)
    assert status is RunScenarioStatus.errored
    assert verdict.status is VerdictStatus.uncertain


def test_an_errored_attempt_among_finished_ones_keeps_the_scenario_finished() -> None:
    status, verdict = summarize_scenario(
        [
            outcome(0, RunScenarioStatus.errored, U),
            outcome(1, RunScenarioStatus.finished, P),
        ],
        2,
        None,
    )
    assert status is RunScenarioStatus.finished
    assert verdict.status is VerdictStatus.uncertain


def test_a_canceled_scenario_reports_why_it_was_stopped() -> None:
    status, verdict = summarize_scenario(
        [outcome(0, RunScenarioStatus.finished, P)], 3, SkipReason.budget_exceeded
    )
    assert status is RunScenarioStatus.canceled
    assert verdict.status is VerdictStatus.skipped
    assert verdict.skip_reason is SkipReason.budget_exceeded
    assert verdict.reason == "stopped after 1 of 3 attempts"


def test_a_scenario_stopped_by_a_precondition_is_skipped() -> None:
    skipped = skipped_verdict(SkipReason.precondition_failed, "oracle not approved")
    status, verdict = summarize_scenario([outcome(0, RunScenarioStatus.skipped, skipped)], 2, None)
    assert status is RunScenarioStatus.skipped
    assert verdict == skipped


def test_a_scenario_with_a_canceled_attempt_is_canceled_even_without_a_signal() -> None:
    status, _ = summarize_scenario([outcome(0, RunScenarioStatus.canceled, None)], 1, None)
    assert status is RunScenarioStatus.canceled
