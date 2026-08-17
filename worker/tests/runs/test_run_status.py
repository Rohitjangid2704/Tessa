import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from tessa_api.db.models import RunRow, RunScenarioRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.common import BudgetState, Verdict
from tessa_api.schemas.enums import AdapterKind, RunScenarioStatus, RunStatus, SkipReason
from tessa_api.schemas.temporal import FinalizeRunInput, UpdateRunStatusInput
from tessa_api.services.run_counters import read_run_counters
from tessa_worker.activities.run_models import PublishRunProgressInput
from tessa_worker.activities.run_status import RunStatusActivities
from tessa_worker.event_client import EventClient
from tessa_worker.verdicts import fail_verdict, pass_verdict, skipped_verdict
from tests.runs.support import RecordingIngest, SeededRun, load_run, seed_run

pytestmark = pytest.mark.integration


@pytest.fixture
def activities(session_factory: SessionFactory, event_client: EventClient) -> RunStatusActivities:
    return RunStatusActivities(session_factory, event_client)


async def update(
    activities: RunStatusActivities,
    run_id: uuid.UUID,
    status: RunStatus,
    reason: str | None = None,
) -> None:
    await ActivityEnvironment().run(
        activities.update_run_status,
        UpdateRunStatusInput(run_id=run_id, status=status, reason=reason),
    )


async def finish_scenarios(
    session_factory: SessionFactory, seeded: SeededRun, verdicts: list[Verdict | None]
) -> None:
    async with session_factory() as session:
        for run_scenario_id, verdict in zip(seeded.run_scenario_ids, verdicts, strict=False):
            row = await session.get(RunScenarioRow, run_scenario_id)
            assert row is not None
            if verdict is None:
                continue
            row.status = RunScenarioStatus.finished
            row.verdict = verdict.model_dump(mode="json")
        await session.commit()


async def test_a_status_change_is_stored_and_announced(
    activities: RunStatusActivities, session_factory: SessionFactory, ingest: RecordingIngest
) -> None:
    seeded = await seed_run(session_factory, scenario_count=0)
    await update(activities, seeded.run_id, RunStatus.planning)
    row = await load_run(session_factory, seeded.run_id)
    assert row.status is RunStatus.planning
    assert row.started_at is not None
    assert row.finished_at is None
    [event] = ingest.of_type("run.status_changed")
    assert event.dedupe_key == "status:planning"
    assert event.payload == {"status": "planning", "previous": "queued", "reason": None}


async def test_the_same_status_twice_changes_nothing_and_emits_nothing_more(
    activities: RunStatusActivities, session_factory: SessionFactory, ingest: RecordingIngest
) -> None:
    seeded = await seed_run(session_factory, scenario_count=0)
    await update(activities, seeded.run_id, RunStatus.planning)
    first = (await load_run(session_factory, seeded.run_id)).started_at
    await update(activities, seeded.run_id, RunStatus.planning)
    assert (await load_run(session_factory, seeded.run_id)).started_at == first
    assert len(ingest.of_type("run.status_changed")) == 1


async def test_the_reason_travels_with_the_status_change(
    activities: RunStatusActivities, session_factory: SessionFactory, ingest: RecordingIngest
) -> None:
    seeded = await seed_run(session_factory, scenario_count=0, status=RunStatus.seeding)
    await update(activities, seeded.run_id, RunStatus.running, "seed_unverified")
    assert ingest.status_changes() == [("seeding", "running", "seed_unverified")]


async def test_a_terminal_status_stamps_the_row_recomputes_counters_and_announces_the_end(
    activities: RunStatusActivities, session_factory: SessionFactory, ingest: RecordingIngest
) -> None:
    seeded = await seed_run(session_factory, scenario_count=3, status=RunStatus.running)
    await finish_scenarios(session_factory, seeded, [pass_verdict(), fail_verdict("boom"), None])
    await update(activities, seeded.run_id, RunStatus.completed)
    row = await load_run(session_factory, seeded.run_id)
    assert row.status is RunStatus.completed
    assert row.finished_at is not None
    assert row.counters["scenarios_total"] == 3
    assert row.counters["scenarios_done"] == 2
    assert row.counters["pass"] == 1
    assert row.counters["fail"] == 1
    assert ingest.types == ["run.status_changed", "run.finished", "dashboard.invalidate"]
    finished = ingest.of_type("run.finished")[0]
    assert finished.dedupe_key == "finished"
    assert finished.payload["status"] == "completed"
    assert finished.payload["counters"]["pass"] == 1
    assert finished.payload["duration_ms"] >= 0


async def test_a_terminal_run_is_never_moved_again(
    activities: RunStatusActivities, session_factory: SessionFactory, ingest: RecordingIngest
) -> None:
    seeded = await seed_run(session_factory, scenario_count=0, status=RunStatus.running)
    await update(activities, seeded.run_id, RunStatus.canceled, "canceled by request")
    await update(activities, seeded.run_id, RunStatus.completed)
    await update(activities, seeded.run_id, RunStatus.running)
    assert (await load_run(session_factory, seeded.run_id)).status is RunStatus.canceled
    assert len(ingest.of_type("run.finished")) == 1


async def test_an_unknown_run_is_a_non_retryable_failure(
    activities: RunStatusActivities,
) -> None:
    with pytest.raises(ApplicationError) as caught:
        await update(activities, new_id(), RunStatus.running)
    assert caught.value.non_retryable is True


async def test_counters_count_done_scenarios_by_verdict_and_every_step(
    session_factory: SessionFactory,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=5, status=RunStatus.running)
    await finish_scenarios(
        session_factory,
        seeded,
        [pass_verdict(), pass_verdict(), fail_verdict("x"), skipped_verdict(SkipReason.canceled)],
    )
    now = datetime.now(UTC)
    async with session_factory() as session:
        for index in range(3):
            session.add(
                StepRow(
                    run_scenario_id=seeded.run_scenario_ids[0],
                    run_id=seeded.run_id,
                    attempt=0,
                    index=index,
                    adapter=AdapterKind.http,
                    label="step",
                    tier0={"passed": True, "failures": []},
                    latency_ms=1,
                    started_at=now,
                    finished_at=now,
                )
            )
        await session.commit()
        counters = await read_run_counters(session, seeded.run_id)
    assert counters.model_dump(by_alias=True) == {
        "scenarios_total": 5,
        "scenarios_done": 4,
        "pass": 2,
        "fail": 1,
        "flaky": 0,
        "uncertain": 0,
        "skipped": 1,
        "steps_recorded": 3,
    }


async def test_finalize_run_persists_counters_and_reports_spend_and_duration(
    activities: RunStatusActivities, session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2, status=RunStatus.running)
    await finish_scenarios(session_factory, seeded, [pass_verdict(), fail_verdict("x")])
    async with session_factory() as session:
        row = await session.get(RunRow, seeded.run_id)
        assert row is not None
        row.spent_usd = Decimal("1.250000")
        await session.commit()
    result = await ActivityEnvironment().run(
        activities.finalize_run, FinalizeRunInput(run_id=seeded.run_id)
    )
    assert result.counters.pass_ == 1
    assert result.counters.fail == 1
    assert result.spent_usd == 1.25
    assert result.duration_ms >= 0
    assert (await load_run(session_factory, seeded.run_id)).counters["fail"] == 1


async def charge_run(session_factory: SessionFactory, run_id: uuid.UUID, usd: str) -> None:
    async with session_factory() as session:
        row = await session.get(RunRow, run_id)
        assert row is not None
        row.spent_usd = Decimal(usd)
        await session.commit()


async def test_publish_progress_stores_counters_reports_the_ledger_spend_and_emits_two_events(
    activities: RunStatusActivities, session_factory: SessionFactory, ingest: RecordingIngest
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2, status=RunStatus.running)
    await finish_scenarios(session_factory, seeded, [pass_verdict(), None])
    await charge_run(session_factory, seeded.run_id, "0.5")
    budget = BudgetState(max_usd=5.0, spent_usd=0.1, max_minutes=30, elapsed_ms=4200)
    result = await ActivityEnvironment().run(
        activities.publish_run_progress,
        PublishRunProgressInput(run_id=seeded.run_id, sequence=3, budget=budget),
    )
    assert result.counters.scenarios_done == 1
    assert result.spent_usd == 0.5
    assert result.blocked_calls == 0
    row = await load_run(session_factory, seeded.run_id)
    assert row.spent_usd == Decimal("0.500000")
    assert row.counters["scenarios_total"] == 2
    assert ingest.types == ["run.progress", "budget.updated"]
    assert [event.dedupe_key for event in ingest.events] == ["progress:3", "budget:3"]
    assert ingest.of_type("run.progress")[0].payload["pass"] == 1
    assert ingest.of_type("budget.updated")[0].payload == {
        "max_usd": 5.0,
        "spent_usd": 0.5,
        "max_minutes": 30,
        "elapsed_ms": 4200,
    }


async def test_publish_progress_does_not_touch_a_finished_run(
    activities: RunStatusActivities, session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, status=RunStatus.running)
    await update(activities, seeded.run_id, RunStatus.failed, "boom")
    budget = BudgetState(max_usd=5.0, spent_usd=9.0, max_minutes=30, elapsed_ms=1)
    await ActivityEnvironment().run(
        activities.publish_run_progress,
        PublishRunProgressInput(run_id=seeded.run_id, sequence=1, budget=budget),
    )
    assert (await load_run(session_factory, seeded.run_id)).spent_usd == Decimal("0")
