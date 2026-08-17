import pytest
from temporalio.client import WorkflowFailureError
from temporalio.testing import WorkflowEnvironment

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import Budget
from tessa_api.schemas.enums import RunScenarioStatus, RunStatus, SkipReason, VerdictStatus
from tessa_api.schemas.temporal import AttemptResult, DriveAttemptInput
from tessa_worker.settings import WorkerSettings
from tests.runs.harness import (
    ScriptedDrive,
    StubPlanning,
    attempt_result,
    heartbeat_until_cancelled,
    ledger_charge,
    run_stack,
    wait_until,
)
from tests.runs.support import (
    RecordingIngest,
    load_run,
    load_run_scenarios,
    seed_run,
    verdict_status,
)

pytestmark = pytest.mark.integration


async def hold_until_cancelled(request: DriveAttemptInput) -> AttemptResult:
    await heartbeat_until_cancelled()
    return attempt_result()


async def test_exhausting_the_minutes_budget_stops_the_run_and_skips_what_never_started(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(
        session_factory, scenario_count=4, budget=Budget(max_usd=5.0, max_minutes=1)
    )
    drive = ScriptedDrive(script=hold_until_cancelled)
    settings = worker_settings.model_copy(update={"run_max_concurrency": 2})
    async with run_stack(
        temporal_env,
        session_factory,
        settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        handle = await stack.start(seeded.run_id)

        async def two_running() -> bool:
            return drive.active == 2

        await wait_until(two_running)
        result = await handle.result()
    assert result.status is RunStatus.budget_exceeded
    assert result.counters.scenarios_done == 4
    assert result.counters.skipped == 4
    rows = await load_run_scenarios(session_factory, seeded.run_id)
    assert sorted(row.status.value for row in rows) == [
        RunScenarioStatus.canceled.value,
        RunScenarioStatus.canceled.value,
        RunScenarioStatus.skipped.value,
        RunScenarioStatus.skipped.value,
    ]
    for row in rows:
        assert verdict_status(row) == VerdictStatus.skipped.value
        assert row.verdict is not None
        assert row.verdict["skip_reason"] == SkipReason.budget_exceeded.value
    skipped = [row for row in rows if row.status is RunScenarioStatus.skipped]
    assert all(row.skip_reason is SkipReason.budget_exceeded for row in skipped)
    assert len(drive.calls) == 2
    assert sorted(drive.cancelled) == sorted(
        row.id for row in rows if row.status.value == "canceled"
    )
    [exhausted] = ingest.of_type("budget.exhausted")
    assert exhausted.payload["dimension"] == "minutes"
    assert exhausted.payload["limit"] == 1.0
    assert exhausted.payload["actual"] >= 1.0
    assert ingest.status_changes()[-1] == (
        "running",
        "budget_exceeded",
        "minutes budget of 1 exhausted",
    )
    stored_run = await load_run(session_factory, seeded.run_id)
    assert stored_run.status is RunStatus.budget_exceeded


async def test_spending_past_the_dollar_budget_stops_the_run(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(
        session_factory, scenario_count=5, budget=Budget(max_usd=1.0, max_minutes=30)
    )
    charge = ledger_charge(session_factory, 0.6)
    charged: list[DriveAttemptInput] = []

    async def expensive(request: DriveAttemptInput) -> AttemptResult:
        if len(charged) == 2:
            await heartbeat_until_cancelled()
        await charge(request)
        charged.append(request)
        return attempt_result()

    settings = worker_settings.model_copy(update={"run_max_concurrency": 1})
    async with run_stack(
        temporal_env,
        session_factory,
        settings,
        ingest,
        drive=ScriptedDrive(script=expensive),
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.budget_exceeded
    assert result.spent_usd == pytest.approx(1.2)
    assert len(charged) == 2
    rows = await load_run_scenarios(session_factory, seeded.run_id)
    assert [row.status for row in rows[:2]] == [RunScenarioStatus.finished] * 2
    assert rows[2].status is RunScenarioStatus.canceled
    assert rows[2].verdict is not None
    assert rows[2].verdict["skip_reason"] == SkipReason.budget_exceeded.value
    assert [row.status for row in rows[3:]] == [RunScenarioStatus.skipped] * 2
    assert {row.skip_reason for row in rows[3:]} == {SkipReason.budget_exceeded}
    [exhausted] = ingest.of_type("budget.exhausted")
    assert exhausted.payload["dimension"] == "usd"
    assert exhausted.payload["limit"] == 1.0
    assert exhausted.payload["actual"] == pytest.approx(1.2)


async def test_canceling_a_run_mid_flight_ends_canceled_with_every_activity_stopped(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=4)
    drive = ScriptedDrive(script=hold_until_cancelled)
    settings = worker_settings.model_copy(update={"run_max_concurrency": 2})
    async with run_stack(
        temporal_env,
        session_factory,
        settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        handle = await stack.start(seeded.run_id)

        async def two_running() -> bool:
            return drive.active == 2

        await wait_until(two_running)
        await handle.signal("cancel")
        result = await handle.result()
    assert result.status is RunStatus.canceled
    assert drive.active == 0
    assert len(drive.cancelled) == 2
    rows = await load_run_scenarios(session_factory, seeded.run_id)
    assert sorted(row.status.value for row in rows) == [
        "canceled",
        "canceled",
        "skipped",
        "skipped",
    ]
    assert all(row.verdict is not None and row.verdict["skip_reason"] == "canceled" for row in rows)
    assert ingest.status_changes()[-2:] == [
        ("running", "canceling", None),
        ("canceling", "canceled", "canceled by request"),
    ]
    assert (await load_run(session_factory, seeded.run_id)).status is RunStatus.canceled
    assert ingest.of_type("budget.exhausted") == []


async def test_canceling_while_the_run_is_being_planned_runs_nothing(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=3)
    drive = ScriptedDrive()
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        handle = await stack.start(seeded.run_id)
        await handle.signal("cancel")
        result = await handle.result()
    assert result.status is RunStatus.canceled
    assert drive.calls == []
    rows = await load_run_scenarios(session_factory, seeded.run_id)
    assert [row.status for row in rows] == [RunScenarioStatus.skipped] * 3


async def test_cancelling_the_workflow_itself_ends_the_run_canceled_and_stops_the_drive(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=3)
    drive = ScriptedDrive(script=hold_until_cancelled)
    settings = worker_settings.model_copy(update={"run_max_concurrency": 2})
    async with run_stack(
        temporal_env,
        session_factory,
        settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        handle = await stack.start(seeded.run_id)

        async def two_running() -> bool:
            return drive.active == 2

        await wait_until(two_running)
        await handle.cancel()
        with pytest.raises(WorkflowFailureError):
            await handle.result()
        await stack.wait_for_status(seeded.run_id, RunStatus.canceled)

        async def idle() -> bool:
            return drive.active == 0

        await wait_until(idle)
    rows = await load_run_scenarios(session_factory, seeded.run_id)
    assert sorted(row.status.value for row in rows) == ["canceled", "canceled", "skipped"]


async def test_a_scenario_workflow_that_fails_is_recorded_errored_and_the_run_goes_on(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=3)
    broken = seeded.run_scenario_ids[1]
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        planning=StubPlanning(seeded=seeded),
        failing_scenarios={broken},
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert (result.counters.pass_, result.counters.uncertain) == (2, 1)
    rows = {row.id: row for row in await load_run_scenarios(session_factory, seeded.run_id)}
    assert rows[broken].status is RunScenarioStatus.errored
    verdict = rows[broken].verdict
    assert verdict is not None
    assert verdict["reason_code"] == "scenario_workflow_failed"
    assert "locked by a failing test" in verdict["reason"]
