import uuid

import pytest

from tessa_api.schemas.enums import MutationOutcome, VerdictStatus
from tessa_api.schemas.mutation import MutationOutcomeItem
from tessa_api.services.mutation_scoring import (
    LatestMutantRun,
    RunResults,
    ScenarioKey,
    ScenarioResult,
    build_summary,
    fold_invariant_statuses,
    score_mutation_run,
)
from tessa_worker.mutation.results import verdict_status_of

PASS = VerdictStatus.pass_
FAIL = VerdictStatus.fail
SKIPPED = VerdictStatus.skipped
UNCERTAIN = VerdictStatus.uncertain
CATCHER = "no_internal_ids"
OTHER = "latency"

KEY = ScenarioKey(uuid.UUID(int=1), "staff", "chat")
SECOND_KEY = ScenarioKey(uuid.UUID(int=2), "manager", "api")


def results(
    scenarios: dict[ScenarioKey, tuple[int, VerdictStatus | None]] | None = None,
    invariants: dict[tuple[ScenarioKey | None, str], VerdictStatus] | None = None,
) -> RunResults:
    return RunResults(
        scenarios={
            key: ScenarioResult(version, status)
            for key, (version, status) in (scenarios or {}).items()
        },
        invariants=invariants or {},
    )


BASELINE = results({KEY: (1, PASS), SECOND_KEY: (1, PASS)}, {(KEY, CATCHER): PASS})


def outcome_of(score_outcomes: list[MutationOutcomeItem], invariant_id: str) -> MutationOutcome:
    return next(item.outcome for item in score_outcomes if item.invariant_id == invariant_id)


def test_a_catcher_that_fails_where_the_baseline_passed_kills_the_mutant() -> None:
    mutant = results({KEY: (1, PASS), SECOND_KEY: (1, PASS)}, {(KEY, CATCHER): FAIL})
    score = score_mutation_run([CATCHER], mutant, BASELINE, aborted=False)
    assert score.outcomes == [
        MutationOutcomeItem(
            invariant_id=CATCHER, outcome=MutationOutcome.killed, caught_by=[KEY.scenario_id]
        )
    ]
    assert score.power == 1.0
    assert score.mutant_outcome is MutationOutcome.killed
    assert score.new_failures == 0


def test_a_catcher_that_still_passes_lets_the_mutant_survive() -> None:
    mutant = results({KEY: (1, PASS)}, {(KEY, CATCHER): PASS})
    score = score_mutation_run([CATCHER], mutant, BASELINE, aborted=False)
    assert outcome_of(score.outcomes, CATCHER) is MutationOutcome.survived
    assert score.power == 0.0
    assert score.mutant_outcome is MutationOutcome.survived


def test_a_failure_the_baseline_already_had_is_not_a_kill() -> None:
    baseline = results({KEY: (1, FAIL)}, {(KEY, CATCHER): FAIL})
    mutant = results({KEY: (1, FAIL)}, {(KEY, CATCHER): FAIL})
    score = score_mutation_run([CATCHER], mutant, baseline, aborted=False)
    assert outcome_of(score.outcomes, CATCHER) is MutationOutcome.survived
    assert score.new_failures == 0
    assert score.mutant_outcome is MutationOutcome.survived


def test_a_failure_on_another_scenario_version_than_the_baseline_is_not_a_kill() -> None:
    mutant = results({KEY: (2, PASS)}, {(KEY, CATCHER): FAIL})
    score = score_mutation_run([CATCHER], mutant, BASELINE, aborted=False)
    assert outcome_of(score.outcomes, CATCHER) is MutationOutcome.survived


def test_a_flaky_catcher_across_attempts_counts_as_a_failure() -> None:
    folded = fold_invariant_statuses([(KEY, CATCHER, PASS), (KEY, CATCHER, FAIL)])
    assert folded == {(KEY, CATCHER): VerdictStatus.flaky}
    mutant = results({KEY: (1, PASS)}, folded)
    score = score_mutation_run([CATCHER], mutant, BASELINE, aborted=False)
    assert outcome_of(score.outcomes, CATCHER) is MutationOutcome.killed


def test_a_run_level_catcher_kills_without_a_scenario_key() -> None:
    baseline = results({KEY: (1, PASS)}, {(None, CATCHER): PASS})
    mutant = results({KEY: (1, PASS)}, {(None, CATCHER): FAIL})
    score = score_mutation_run([CATCHER], mutant, baseline, aborted=False)
    assert score.outcomes == [
        MutationOutcomeItem(invariant_id=CATCHER, outcome=MutationOutcome.killed, caught_by=[])
    ]


def test_a_catcher_that_only_skipped_or_never_ran_is_skipped_and_not_measured() -> None:
    skipped = results({KEY: (1, PASS)}, {(KEY, CATCHER): SKIPPED})
    for mutant in (skipped, results({KEY: (1, PASS)})):
        score = score_mutation_run([CATCHER], mutant, BASELINE, aborted=False)
        assert outcome_of(score.outcomes, CATCHER) is MutationOutcome.skipped
        assert score.power is None
        assert score.mutant_outcome is MutationOutcome.skipped


def test_an_uncertain_catcher_is_errored_never_survived() -> None:
    mutant = results({KEY: (1, PASS)}, {(KEY, CATCHER): UNCERTAIN})
    score = score_mutation_run([CATCHER], mutant, BASELINE, aborted=False)
    assert outcome_of(score.outcomes, CATCHER) is MutationOutcome.errored
    assert score.power is None
    assert score.mutant_outcome is MutationOutcome.errored


def test_a_new_scenario_failure_kills_the_mutant_even_when_every_catcher_survives() -> None:
    mutant = results({KEY: (1, PASS), SECOND_KEY: (1, FAIL)}, {(KEY, CATCHER): PASS})
    score = score_mutation_run([CATCHER], mutant, BASELINE, aborted=False)
    assert outcome_of(score.outcomes, CATCHER) is MutationOutcome.survived
    assert score.new_failures == 1
    assert score.power == 0.0
    assert score.mutant_outcome is MutationOutcome.killed


def test_an_aborted_run_scores_every_expected_catcher_errored() -> None:
    mutant = results({KEY: (1, FAIL)}, {(KEY, CATCHER): FAIL})
    score = score_mutation_run([CATCHER, OTHER], mutant, BASELINE, aborted=True)
    assert [item.outcome for item in score.outcomes] == [MutationOutcome.errored] * 2
    assert score.power is None
    assert score.new_failures == 0
    assert score.mutant_outcome is MutationOutcome.errored


def test_power_is_the_share_of_killed_among_the_measured_catchers() -> None:
    baseline = results({KEY: (1, PASS)}, {(KEY, CATCHER): PASS, (KEY, OTHER): PASS})
    mutant = results({KEY: (1, PASS)}, {(KEY, CATCHER): FAIL, (KEY, OTHER): PASS})
    score = score_mutation_run([CATCHER, OTHER, "never_ran"], mutant, baseline, aborted=False)
    assert score.power == 0.5


def latest(
    name: str, outcome: MutationOutcome | None, items: list[MutationOutcomeItem]
) -> LatestMutantRun:
    return LatestMutantRun(mutant_id=uuid.uuid4(), name=name, last_outcome=outcome, outcomes=items)


def test_the_summary_measures_only_killed_and_survived_mutants_and_names_the_survivors() -> None:
    killed = MutationOutcomeItem(
        invariant_id=CATCHER, outcome=MutationOutcome.killed, caught_by=[KEY.scenario_id]
    )
    survived = MutationOutcomeItem(
        invariant_id=OTHER, outcome=MutationOutcome.survived, caught_by=[]
    )
    summary = build_summary(
        [
            latest("zeta", MutationOutcome.survived, [survived]),
            latest("alpha", MutationOutcome.killed, [killed]),
            latest("beta", MutationOutcome.survived, [survived, killed]),
            latest("errored", MutationOutcome.errored, [killed]),
            latest("never", None, []),
        ]
    )
    assert summary.total == 3
    assert summary.killed == 1
    assert summary.suite_power == pytest.approx(1 / 3, abs=1e-6)
    assert [survivor.name for survivor in summary.survivors] == ["beta", "zeta"]
    assert summary.survivors[0].invariant_ids == [OTHER]
    assert {(item.invariant_id, item.killed, item.survived) for item in summary.per_invariant} == {
        (CATCHER, 2, 0),
        (OTHER, 0, 2),
    }


def test_an_empty_summary_has_no_power() -> None:
    summary = build_summary([])
    assert summary.suite_power is None
    assert summary.total == 0


@pytest.mark.parametrize(
    ("verdict", "expected"),
    [
        ({"status": "pass"}, PASS),
        ({"status": "flaky"}, VerdictStatus.flaky),
        ({"status": "not-a-status"}, None),
        ({"status": None}, None),
        ({"status": 3}, None),
        ({}, None),
        (None, None),
    ],
)
def test_a_stored_scenario_verdict_is_read_as_a_status_or_nothing(
    verdict: dict[str, object] | None, expected: VerdictStatus | None
) -> None:
    assert verdict_status_of(verdict) is expected
