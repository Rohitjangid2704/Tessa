import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from tessa_api.schemas.enums import MutationOutcome, VerdictStatus
from tessa_api.schemas.mutation import (
    MutationInvariantPower,
    MutationOutcomeItem,
    MutationSummary,
    MutationSurvivor,
)
from tessa_api.services.verdicts import across_attempts_status

FAILING_STATUSES = frozenset({VerdictStatus.fail, VerdictStatus.flaky})
DECIDED_STATUSES = frozenset({VerdictStatus.pass_, VerdictStatus.fail, VerdictStatus.flaky})
MEASURED_OUTCOMES = frozenset({MutationOutcome.killed, MutationOutcome.survived})
POWER_DIGITS = 6


@dataclass(frozen=True, slots=True, order=True)
class ScenarioKey:
    scenario_id: uuid.UUID
    role: str
    interface_id: str


@dataclass(frozen=True, slots=True)
class ScenarioResult:
    version: int
    status: VerdictStatus | None


InvariantIdentity = tuple[ScenarioKey | None, str]


@dataclass(frozen=True, slots=True)
class RunResults:
    scenarios: Mapping[ScenarioKey, ScenarioResult]
    invariants: Mapping[InvariantIdentity, VerdictStatus]


@dataclass(frozen=True, slots=True)
class MutationScore:
    outcomes: list[MutationOutcomeItem]
    power: float | None
    mutant_outcome: MutationOutcome
    new_failures: int


@dataclass(frozen=True, slots=True)
class LatestMutantRun:
    mutant_id: uuid.UUID
    name: str
    last_outcome: MutationOutcome | None
    outcomes: Sequence[MutationOutcomeItem]


def fold_invariant_statuses(
    rows: Iterable[tuple[ScenarioKey | None, str, VerdictStatus]],
) -> dict[InvariantIdentity, VerdictStatus]:
    grouped: dict[InvariantIdentity, list[VerdictStatus]] = defaultdict(list)
    for key, invariant_id, status in rows:
        grouped[(key, invariant_id)].append(status)
    return {identity: across_attempts_status(statuses) for identity, statuses in grouped.items()}


def is_new_scenario_failure(key: ScenarioKey, result: ScenarioResult, baseline: RunResults) -> bool:
    if result.status not in FAILING_STATUSES:
        return False
    before = baseline.scenarios.get(key)
    return (
        before is not None
        and before.version == result.version
        and before.status is VerdictStatus.pass_
    )


def new_scenario_failures(mutant: RunResults, baseline: RunResults) -> list[ScenarioKey]:
    return sorted(
        key
        for key, result in mutant.scenarios.items()
        if is_new_scenario_failure(key, result, baseline)
    )


def same_scenario_version(
    key: ScenarioKey | None, mutant: RunResults, baseline: RunResults
) -> bool:
    if key is None:
        return True
    during = mutant.scenarios.get(key)
    before = baseline.scenarios.get(key)
    return during is not None and before is not None and during.version == before.version


def new_invariant_failures(
    invariant_id: str, mutant: RunResults, baseline: RunResults
) -> list[ScenarioKey | None]:
    return [
        key
        for (key, identity), status in mutant.invariants.items()
        if identity == invariant_id
        and status in FAILING_STATUSES
        and baseline.invariants.get((key, invariant_id)) is VerdictStatus.pass_
        and same_scenario_version(key, mutant, baseline)
    ]


def outcome_item(
    invariant_id: str, outcome: MutationOutcome, caught_by: Sequence[uuid.UUID] = ()
) -> MutationOutcomeItem:
    return MutationOutcomeItem(
        invariant_id=invariant_id, outcome=outcome, caught_by=list(caught_by)
    )


def caught_scenarios(failures: Iterable[ScenarioKey | None]) -> list[uuid.UUID]:
    return sorted({key.scenario_id for key in failures if key is not None}, key=str)


def score_catcher(
    invariant_id: str, mutant: RunResults, baseline: RunResults
) -> MutationOutcomeItem:
    statuses = [
        status for (_, identity), status in mutant.invariants.items() if identity == invariant_id
    ]
    if all(status is VerdictStatus.skipped for status in statuses):
        return outcome_item(invariant_id, MutationOutcome.skipped)
    failures = new_invariant_failures(invariant_id, mutant, baseline)
    if failures:
        return outcome_item(invariant_id, MutationOutcome.killed, caught_scenarios(failures))
    if any(status in DECIDED_STATUSES for status in statuses):
        return outcome_item(invariant_id, MutationOutcome.survived)
    return outcome_item(invariant_id, MutationOutcome.errored)


def aborted_outcomes(expected_catchers: Sequence[str]) -> list[MutationOutcomeItem]:
    return [
        outcome_item(invariant_id, MutationOutcome.errored) for invariant_id in expected_catchers
    ]


def catcher_power(outcomes: Sequence[MutationOutcomeItem]) -> float | None:
    killed = sum(1 for item in outcomes if item.outcome is MutationOutcome.killed)
    survived = sum(1 for item in outcomes if item.outcome is MutationOutcome.survived)
    decided = killed + survived
    return None if decided == 0 else round(killed / decided, POWER_DIGITS)


def mutant_outcome_of(
    outcomes: Sequence[MutationOutcomeItem], new_failures: int
) -> MutationOutcome:
    kinds = {item.outcome for item in outcomes}
    if new_failures > 0 or MutationOutcome.killed in kinds:
        return MutationOutcome.killed
    if MutationOutcome.survived in kinds:
        return MutationOutcome.survived
    if MutationOutcome.errored in kinds:
        return MutationOutcome.errored
    return MutationOutcome.skipped


def score_mutation_run(
    expected_catchers: Sequence[str], mutant: RunResults, baseline: RunResults, aborted: bool
) -> MutationScore:
    if aborted:
        return MutationScore(
            outcomes=aborted_outcomes(expected_catchers),
            power=None,
            mutant_outcome=MutationOutcome.errored,
            new_failures=0,
        )
    outcomes = [score_catcher(invariant_id, mutant, baseline) for invariant_id in expected_catchers]
    new_failures = len(new_scenario_failures(mutant, baseline))
    return MutationScore(
        outcomes=outcomes,
        power=catcher_power(outcomes),
        mutant_outcome=mutant_outcome_of(outcomes, new_failures),
        new_failures=new_failures,
    )


def suite_power(killed: int, total: int) -> float | None:
    return None if total == 0 else round(killed / total, POWER_DIGITS)


def survivor_of(entry: LatestMutantRun) -> MutationSurvivor:
    return MutationSurvivor(
        mutant_id=entry.mutant_id,
        name=entry.name,
        invariant_ids=[
            item.invariant_id for item in entry.outcomes if item.outcome is MutationOutcome.survived
        ],
    )


def invariant_powers(measured: Sequence[LatestMutantRun]) -> list[MutationInvariantPower]:
    killed: dict[str, int] = defaultdict(int)
    survived: dict[str, int] = defaultdict(int)
    for entry in measured:
        for item in entry.outcomes:
            if item.outcome is MutationOutcome.killed:
                killed[item.invariant_id] += 1
            elif item.outcome is MutationOutcome.survived:
                survived[item.invariant_id] += 1
    return [
        MutationInvariantPower(
            invariant_id=invariant_id, killed=killed[invariant_id], survived=survived[invariant_id]
        )
        for invariant_id in sorted({*killed, *survived})
    ]


def build_summary(entries: Sequence[LatestMutantRun]) -> MutationSummary:
    measured = [entry for entry in entries if entry.last_outcome in MEASURED_OUTCOMES]
    killed = sum(1 for entry in measured if entry.last_outcome is MutationOutcome.killed)
    survivors = sorted(
        (
            survivor_of(entry)
            for entry in measured
            if entry.last_outcome is MutationOutcome.survived
        ),
        key=lambda survivor: survivor.name,
    )
    return MutationSummary(
        suite_power=suite_power(killed, len(measured)),
        killed=killed,
        total=len(measured),
        survivors=survivors,
        per_invariant=invariant_powers(measured),
    )
