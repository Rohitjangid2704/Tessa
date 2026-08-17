import uuid
from collections.abc import Sequence

import pytest
from sqlalchemy import select
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from tessa_api.db.models import BundleRow, FindingRow, RunScenarioRow, ScenarioRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import (
    FindingClass,
    RunKind,
    RunScenarioStatus,
    RunStatus,
    ScenarioStatus,
    VerdictStatus,
    VerdictTier,
)
from tessa_api.schemas.temporal import ApplyFlakinessPolicyInput, ApplyFlakinessPolicyResult
from tessa_api.services.flakiness import (
    FlakinessRecord,
    RunOutcome,
    advance,
    record_of,
    run_outcome,
)
from tessa_worker.activities.flakiness import FlakinessActivities
from tessa_worker.event_client import EventClient
from tessa_worker.settings import WorkerSettings
from tests.runs.support import RecordingIngest, SeededRun, new_run_row, seed_run

QUARANTINE_AFTER = 3
FLAKY = VerdictStatus.flaky
PASS = VerdictStatus.pass_
FAIL = VerdictStatus.fail


def test_a_run_is_flaky_when_any_row_of_the_scenario_is_flaky() -> None:
    assert run_outcome([PASS, FLAKY]) is RunOutcome.flaky
    assert run_outcome([PASS, FAIL]) is RunOutcome.steady
    assert run_outcome([VerdictStatus.uncertain, None]) is RunOutcome.undecided


def test_the_streak_grows_on_flaky_runs_and_quarantines_at_the_threshold() -> None:
    record = FlakinessRecord()
    quarantines = []
    for _ in range(QUARANTINE_AFTER):
        step = advance(record, uuid.uuid4(), RunOutcome.flaky, QUARANTINE_AFTER)
        assert step.counted
        record = step.record
        quarantines.append(step.quarantine)
    assert record.streak == QUARANTINE_AFTER
    assert quarantines == [False, False, True]


def test_a_steady_run_resets_the_streak_and_an_undecided_run_is_not_counted() -> None:
    record = advance(FlakinessRecord(), uuid.uuid4(), RunOutcome.flaky, QUARANTINE_AFTER).record
    undecided = advance(record, uuid.uuid4(), RunOutcome.undecided, QUARANTINE_AFTER)
    assert not undecided.counted
    assert undecided.record.streak == 1
    steady = advance(record, uuid.uuid4(), RunOutcome.steady, QUARANTINE_AFTER)
    assert steady.counted
    assert steady.record.streak == 0


def test_the_same_run_is_never_counted_twice() -> None:
    run_id = uuid.uuid4()
    first = advance(FlakinessRecord(), run_id, RunOutcome.flaky, QUARANTINE_AFTER)
    again = advance(first.record, run_id, RunOutcome.flaky, QUARANTINE_AFTER)
    assert not again.counted
    assert again.record.streak == 1


def test_an_unreadable_stored_record_starts_over() -> None:
    assert record_of({"flakiness": {"streak": -4}}) == FlakinessRecord()
    assert record_of(None) == FlakinessRecord()


def verdict_of(status: VerdictStatus) -> dict[str, object]:
    return Verdict(
        status=status,
        tier=VerdictTier.code,
        confidence=None,
        reason_code=status.value,
        reason=None,
        skip_reason=None,
    ).model_dump(mode="json")


async def add_run(
    session_factory: SessionFactory,
    seeded: SeededRun,
    statuses: Sequence[VerdictStatus],
    kind: RunKind = RunKind.suite,
) -> uuid.UUID:
    async with session_factory() as session:
        bundle = await session.get(BundleRow, seeded.bundle_id)
        assert bundle is not None
        run = new_run_row(
            seeded.target_id,
            seeded.plan_id,
            seeded.bundle_id,
            bundle.hash,
            seeded.user_id,
            status=RunStatus.running,
        )
        run.kind = kind
        session.add(run)
        await session.flush()
        for scenario_id, status in zip(seeded.scenario_ids, statuses, strict=True):
            session.add(
                RunScenarioRow(
                    run_id=run.id,
                    scenario_id=scenario_id,
                    scenario_version=1,
                    role="staff",
                    interface_id="chat",
                    attempts_total=2,
                    status=RunScenarioStatus.finished,
                    attempts=[],
                    verdict=verdict_of(status),
                )
            )
        await session.commit()
        return run.id


async def scenario_of(session_factory: SessionFactory, scenario_id: uuid.UUID) -> ScenarioRow:
    async with session_factory() as session:
        row = await session.get(ScenarioRow, scenario_id)
        assert row is not None
        return row


async def flaky_findings(session_factory: SessionFactory, target_id: uuid.UUID) -> list[FindingRow]:
    async with session_factory() as session:
        rows = await session.scalars(
            select(FindingRow).where(
                FindingRow.target_id == target_id, FindingRow.class_ == FindingClass.flaky
            )
        )
        return list(rows)


@pytest.fixture
def policy(
    worker_settings: WorkerSettings, session_factory: SessionFactory, event_client: EventClient
) -> FlakinessActivities:
    settings = worker_settings.model_copy(update={"flaky_quarantine_after": QUARANTINE_AFTER})
    return FlakinessActivities(settings, session_factory, event_client)


async def apply(policy: FlakinessActivities, run_id: uuid.UUID) -> ApplyFlakinessPolicyResult:
    result: ApplyFlakinessPolicyResult = await ActivityEnvironment().run(
        policy.apply_flakiness_policy, ApplyFlakinessPolicyInput(run_id=run_id)
    )
    return result


@pytest.mark.integration
async def test_three_flaky_runs_in_a_row_quarantine_the_scenario_and_file_one_flaky_finding(
    session_factory: SessionFactory, policy: FlakinessActivities, ingest: RecordingIngest
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2, create_run_scenarios=True)
    flaky_id, steady_id = seeded.scenario_ids
    results = [
        await apply(policy, await add_run(session_factory, seeded, [FLAKY, PASS]))
        for _ in range(QUARANTINE_AFTER)
    ]
    assert [result.quarantined for result in results[:-1]] == [[], []]
    assert results[-1].quarantined == [flaky_id]
    quarantined = await scenario_of(session_factory, flaky_id)
    assert quarantined.status is ScenarioStatus.quarantined
    assert record_of(quarantined.provenance).streak == QUARANTINE_AFTER
    assert record_of(quarantined.provenance).quarantined_at is not None
    steady = await scenario_of(session_factory, steady_id)
    assert steady.status is ScenarioStatus.accepted
    assert record_of(steady.provenance).streak == 0
    findings = await flaky_findings(session_factory, seeded.target_id)
    assert [finding.id for finding in findings] == results[-1].findings
    assert findings[0].scenario_id == flaky_id
    assert "dashboard.invalidate" in ingest.types


@pytest.mark.integration
async def test_a_steady_run_between_flaky_runs_restarts_the_count(
    session_factory: SessionFactory, policy: FlakinessActivities
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    statuses = [FLAKY, FLAKY, FAIL, FLAKY, FLAKY]
    for status in statuses:
        result = await apply(policy, await add_run(session_factory, seeded, [status]))
        assert result.quarantined == []
    row = await scenario_of(session_factory, seeded.scenario_ids[0])
    assert row.status is ScenarioStatus.accepted
    assert record_of(row.provenance).streak == 2
    assert await flaky_findings(session_factory, seeded.target_id) == []


@pytest.mark.integration
async def test_applying_the_policy_twice_to_the_same_run_counts_it_once(
    session_factory: SessionFactory, policy: FlakinessActivities
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    run_id = await add_run(session_factory, seeded, [FLAKY])
    for _ in range(QUARANTINE_AFTER):
        await apply(policy, run_id)
    row = await scenario_of(session_factory, seeded.scenario_ids[0])
    assert record_of(row.provenance).streak == 1
    assert row.status is ScenarioStatus.accepted


@pytest.mark.integration
async def test_synthetic_scenarios_and_runs_that_are_not_suites_are_left_alone(
    session_factory: SessionFactory, policy: FlakinessActivities
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    for _ in range(QUARANTINE_AFTER):
        result = await apply(
            policy, await add_run(session_factory, seeded, [FLAKY], kind=RunKind.mutation)
        )
        assert result.quarantined == []
    async with session_factory() as session:
        row = await session.get(ScenarioRow, seeded.scenario_ids[0])
        assert row is not None
        row.parsed = {**row.parsed, "synthetic": True}
        await session.commit()
    for _ in range(QUARANTINE_AFTER):
        result = await apply(policy, await add_run(session_factory, seeded, [FLAKY]))
        assert result.quarantined == []
    row = await scenario_of(session_factory, seeded.scenario_ids[0])
    assert row.status is ScenarioStatus.accepted
    assert record_of(row.provenance).streak == 0


@pytest.mark.integration
async def test_a_missing_run_is_a_permanent_failure(policy: FlakinessActivities) -> None:
    with pytest.raises(ApplicationError) as caught:
        await apply(policy, uuid.uuid4())
    assert caught.value.non_retryable
