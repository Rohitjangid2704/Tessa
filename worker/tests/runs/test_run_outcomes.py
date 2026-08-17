from itertools import cycle

import pytest
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import RunScenarioStatus, RunStatus, SkipReason
from tessa_api.schemas.temporal import AttemptResult, DriveAttemptInput, SeedAssertionResult
from tessa_worker.settings import WorkerSettings
from tessa_worker.verdicts import fail_verdict, pass_verdict, skipped_verdict
from tests.runs.harness import (
    ScriptedDrive,
    ScriptedSeedGate,
    StubPlanning,
    attempt_result,
    ledger_charge,
    run_stack,
)
from tests.runs.support import (
    RecordingIngest,
    load_run,
    load_run_scenarios,
    seed_run,
    verdict_status,
)

pytestmark = pytest.mark.integration


async def test_mixed_attempts_make_a_scenario_flaky(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, attempts=3)
    verdicts = cycle(
        [pass_verdict(), fail_verdict("status: expected 200, got 500"), pass_verdict()]
    )

    async def alternate(request: DriveAttemptInput) -> AttemptResult:
        return attempt_result(verdict=next(verdicts))

    drive = ScriptedDrive(script=alternate)
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert result.counters.flaky == 1
    assert result.counters.pass_ == 0
    [row] = await load_run_scenarios(session_factory, seeded.run_id)
    assert row.status is RunScenarioStatus.finished
    assert row.verdict is not None
    assert row.verdict["status"] == "flaky"
    assert row.verdict["reason"] == "2 of 3 attempts passed"
    assert row.verdict["tier"] == "code"
    assert [entry["verdict"]["status"] for entry in row.attempts] == ["pass", "fail", "pass"]
    assert [call.attempt for call in drive.calls] == [0, 1, 2]
    verdict_events = ingest.of_type("scenario.verdict")
    assert [event.payload["attempt"] for event in verdict_events] == [0, 1, 2]
    [finished] = ingest.of_type("scenario.finished")
    assert finished.payload["attempts"] == {"passed": 2, "failed": 1, "total": 3}
    assert finished.payload["verdict"]["status"] == "flaky"


async def test_attempts_that_all_fail_make_a_failed_scenario_and_all_pass_a_passed_one(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2, attempts=2)
    failing_scenario = seeded.run_scenario_ids[0]

    async def by_scenario(request: DriveAttemptInput) -> AttemptResult:
        if request.run_scenario_id == failing_scenario:
            return attempt_result(verdict=fail_verdict("boom"))
        return attempt_result()

    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=ScriptedDrive(script=by_scenario),
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert (result.counters.pass_, result.counters.fail, result.counters.flaky) == (1, 1, 0)
    first, second = await load_run_scenarios(session_factory, seeded.run_id)
    assert (verdict_status(first), verdict_status(second)) == ("fail", "pass")


async def test_a_drive_activity_that_blows_up_becomes_an_errored_attempt_never_a_pass(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, attempts=2)

    async def crash(request: DriveAttemptInput) -> AttemptResult:
        raise ApplicationError("browser crashed", non_retryable=True)

    drive = ScriptedDrive(script=crash)
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert result.counters.uncertain == 1
    assert result.counters.pass_ == 0
    [row] = await load_run_scenarios(session_factory, seeded.run_id)
    assert row.status is RunScenarioStatus.errored
    assert row.verdict is not None
    assert row.verdict["status"] == "uncertain"
    assert row.verdict["reason_code"] == "attempt_errored"
    assert [entry["status"] for entry in row.attempts] == ["errored", "errored"]
    assert "browser crashed" in row.attempts[0]["verdict"]["reason"]
    assert len(drive.calls) == 2


async def test_an_errored_attempt_does_not_stop_the_remaining_attempts(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, attempts=2)
    calls = {"count": 0}

    async def crash_once(request: DriveAttemptInput) -> AttemptResult:
        calls["count"] += 1
        if calls["count"] == 1:
            raise ApplicationError("worker lost", non_retryable=True)
        return attempt_result()

    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=ScriptedDrive(script=crash_once),
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        await stack.run(seeded.run_id)
    [row] = await load_run_scenarios(session_factory, seeded.run_id)
    assert row.status is RunScenarioStatus.finished
    assert row.verdict is not None
    assert row.verdict["status"] == "uncertain"
    assert [entry["status"] for entry in row.attempts] == ["errored", "finished"]


async def test_a_scenario_stopped_by_a_precondition_is_skipped_with_its_reason(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, attempts=3)
    verdict = skipped_verdict(SkipReason.precondition_failed, "oracle open_issues is not approved")

    async def halted(request: DriveAttemptInput) -> AttemptResult:
        return attempt_result(verdict=verdict, status=RunScenarioStatus.skipped, steps_recorded=0)

    drive = ScriptedDrive(script=halted)
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.counters.skipped == 1
    [row] = await load_run_scenarios(session_factory, seeded.run_id)
    assert row.status is RunScenarioStatus.skipped
    assert row.skip_reason is SkipReason.precondition_failed
    assert row.verdict is not None
    assert row.verdict["reason"] == "oracle open_issues is not approved"
    assert len(drive.calls) == 1
    assert [entry["status"] for entry in row.attempts] == ["skipped", "skipped", "skipped"]


async def test_the_spend_of_every_attempt_is_added_to_the_run(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2, attempts=2)
    charge = ledger_charge(session_factory, 0.25)

    async def priced(request: DriveAttemptInput) -> AttemptResult:
        await charge(request)
        return attempt_result()

    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=ScriptedDrive(script=priced),
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert result.spent_usd == pytest.approx(1.0)
    assert (await load_run(session_factory, seeded.run_id)).spent_usd == pytest.approx(1)
    last_budget = ingest.of_type("budget.updated")[-1]
    assert last_budget.payload["spent_usd"] == pytest.approx(1.0)


async def test_progress_events_are_coalesced_and_the_last_one_is_complete(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=12)
    settings = worker_settings.model_copy(update={"run_max_concurrency": 6})
    async with run_stack(
        temporal_env,
        session_factory,
        settings,
        ingest,
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        await stack.run(seeded.run_id)
    progress = ingest.of_type("run.progress")
    assert 1 <= len(progress) < 12
    assert len(ingest.of_type("budget.updated")) == len(progress)
    assert progress[-1].payload["scenarios_done"] == 12
    assert progress[-1].payload["pass"] == 12


async def test_a_seed_mismatch_fails_the_run_and_skips_every_scenario(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=3)
    gate = ScriptedSeedGate(
        result=SeedAssertionResult(
            outcome="mismatch",
            seed_hash=None,
            observed_hash="b",
            expected_hash="a",
            reason="hash differs",
        )
    )
    drive = ScriptedDrive()
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
        seed_gate=gate,
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.failed
    assert drive.calls == []
    rows = await load_run_scenarios(session_factory, seeded.run_id)
    assert all(row.skip_reason is SkipReason.seed_mismatch for row in rows)
    assert ingest.status_changes()[-1] == ("seeding", "failed", "hash differs")


async def test_a_verified_seed_moves_on_without_a_reason(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    gate = ScriptedSeedGate(
        result=SeedAssertionResult(
            outcome="matched",
            seed_hash="a",
            observed_hash="a",
            expected_hash="a",
            reason=None,
        )
    )
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        planning=StubPlanning(seeded=seeded),
        seed_gate=gate,
    ) as stack:
        await stack.run(seeded.run_id)
    assert ("seeding", "running", None) in ingest.status_changes()


async def test_a_failure_while_planning_marks_the_run_failed_and_fails_the_workflow(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    planning = StubPlanning(
        seeded=seeded,
        cell_ids=[seeded.plan_id],
        generate_failure=ApplicationError("bundle example is unreadable", non_retryable=True),
    )
    drive = ScriptedDrive()
    async with run_stack(
        temporal_env, session_factory, worker_settings, ingest, drive=drive, planning=planning
    ) as stack:
        handle = await stack.start(seeded.run_id)
        with pytest.raises(WorkflowFailureError):
            await handle.result()
    row = await load_run(session_factory, seeded.run_id)
    assert row.status is RunStatus.failed
    assert row.finished_at is not None
    assert drive.calls == []
    [change] = [change for change in ingest.status_changes() if change[1] == "failed"]
    assert change[0] == "planning"
    assert change[2] is not None
    assert "bundle example is unreadable" in change[2]
    assert ingest.types[-2:] == ["run.finished", "dashboard.invalidate"]


async def test_the_progress_query_reports_counters_and_budget(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2)
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        handle = await stack.start(seeded.run_id)
        await handle.result()
        progress = await handle.query("progress")
    assert progress["counters"]["scenarios_done"] == 2
    assert progress["budget"]["max_minutes"] == 30
    assert progress["budget"]["elapsed_ms"] >= 0
