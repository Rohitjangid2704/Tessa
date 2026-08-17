import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.enums import RunScenarioStatus, SkipReason, VerdictStatus
from tessa_worker.activities.run_models import (
    BeginScenarioAttemptInput,
    FinishRunScenarioInput,
    RecordScenarioAttemptInput,
    SkipRunScenariosInput,
)
from tessa_worker.activities.scenario_lifecycle import ScenarioLifecycleActivities
from tessa_worker.event_client import EventClient
from tessa_worker.verdicts import fail_verdict, pass_verdict, skipped_verdict
from tests.runs.support import RecordingIngest, load_run_scenario, load_run_scenarios, seed_run

pytestmark = pytest.mark.integration


@pytest.fixture
def activities(
    session_factory: SessionFactory, event_client: EventClient
) -> ScenarioLifecycleActivities:
    return ScenarioLifecycleActivities(session_factory, event_client)


async def test_beginning_an_attempt_marks_the_scenario_running_and_announces_it(
    activities: ScenarioLifecycleActivities,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, attempts=2)
    run_scenario_id = seeded.run_scenario_ids[0]
    await ActivityEnvironment().run(
        activities.begin_scenario_attempt,
        BeginScenarioAttemptInput(run_scenario_id=run_scenario_id, attempt=0),
    )
    row = await load_run_scenario(session_factory, run_scenario_id)
    assert row.status is RunScenarioStatus.running
    assert row.started_at is not None
    assert [entry["status"] for entry in row.attempts] == ["running", "queued"]
    [event] = ingest.of_type("scenario.started")
    assert event.dedupe_key == f"scenario.started:{run_scenario_id}:0"
    assert event.payload == {"run_scenario_id": str(run_scenario_id), "attempt": 0}


async def test_a_later_attempt_keeps_the_first_start_time(
    activities: ScenarioLifecycleActivities, session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, attempts=2)
    run_scenario_id = seeded.run_scenario_ids[0]
    environment = ActivityEnvironment()
    await environment.run(
        activities.begin_scenario_attempt,
        BeginScenarioAttemptInput(run_scenario_id=run_scenario_id, attempt=0),
    )
    first = (await load_run_scenario(session_factory, run_scenario_id)).started_at
    await environment.run(
        activities.begin_scenario_attempt,
        BeginScenarioAttemptInput(run_scenario_id=run_scenario_id, attempt=1),
    )
    assert (await load_run_scenario(session_factory, run_scenario_id)).started_at == first


async def test_recording_an_attempt_stores_the_verdict_and_announces_it(
    activities: ScenarioLifecycleActivities,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, attempts=2)
    run_scenario_id = seeded.run_scenario_ids[0]
    await ActivityEnvironment().run(
        activities.record_scenario_attempt,
        RecordScenarioAttemptInput(
            run_scenario_id=run_scenario_id,
            attempt=1,
            status=RunScenarioStatus.finished,
            verdict=fail_verdict("status: expected 200, got 500"),
        ),
    )
    row = await load_run_scenario(session_factory, run_scenario_id)
    assert row.attempts[1]["status"] == "finished"
    assert row.attempts[1]["verdict"]["status"] == "fail"
    assert row.attempts[0]["status"] == "queued"
    [event] = ingest.of_type("scenario.verdict")
    assert event.payload["attempt"] == 1
    assert event.payload["verdict"]["reason_code"] == "tier0_failed"


async def test_an_attempt_without_a_verdict_announces_nothing(
    activities: ScenarioLifecycleActivities,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    await ActivityEnvironment().run(
        activities.record_scenario_attempt,
        RecordScenarioAttemptInput(
            run_scenario_id=seeded.run_scenario_ids[0],
            attempt=0,
            status=RunScenarioStatus.canceled,
            verdict=None,
        ),
    )
    assert ingest.of_type("scenario.verdict") == []


async def test_finishing_a_scenario_stores_the_result_and_the_attempt_tally(
    activities: ScenarioLifecycleActivities,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, attempts=3)
    run_scenario_id = seeded.run_scenario_ids[0]
    environment = ActivityEnvironment()
    for attempt, verdict in enumerate([pass_verdict(), fail_verdict("x"), pass_verdict()]):
        await environment.run(
            activities.begin_scenario_attempt,
            BeginScenarioAttemptInput(run_scenario_id=run_scenario_id, attempt=attempt),
        )
        await environment.run(
            activities.record_scenario_attempt,
            RecordScenarioAttemptInput(
                run_scenario_id=run_scenario_id,
                attempt=attempt,
                status=RunScenarioStatus.finished,
                verdict=verdict,
            ),
        )
    flaky = fail_verdict("2 of 3 attempts passed")
    await environment.run(
        activities.finish_run_scenario,
        FinishRunScenarioInput(
            run_scenario_id=run_scenario_id, status=RunScenarioStatus.finished, verdict=flaky
        ),
    )
    row = await load_run_scenario(session_factory, run_scenario_id)
    assert row.status is RunScenarioStatus.finished
    assert row.finished_at is not None
    assert row.skip_reason is None
    [event] = ingest.of_type("scenario.finished")
    assert event.dedupe_key == f"scenario.finished:{run_scenario_id}"
    assert event.payload["attempts"] == {"passed": 2, "failed": 1, "total": 3}
    assert event.payload["status"] == "finished"
    assert event.payload["duration_ms"] >= 0


async def test_finishing_twice_keeps_the_first_result(
    activities: ScenarioLifecycleActivities,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    run_scenario_id = seeded.run_scenario_ids[0]
    environment = ActivityEnvironment()
    await environment.run(
        activities.finish_run_scenario,
        FinishRunScenarioInput(
            run_scenario_id=run_scenario_id,
            status=RunScenarioStatus.finished,
            verdict=pass_verdict(),
        ),
    )
    await environment.run(
        activities.finish_run_scenario,
        FinishRunScenarioInput(
            run_scenario_id=run_scenario_id,
            status=RunScenarioStatus.canceled,
            verdict=skipped_verdict(SkipReason.canceled),
        ),
    )
    row = await load_run_scenario(session_factory, run_scenario_id)
    assert row.status is RunScenarioStatus.finished
    assert row.verdict is not None
    assert row.verdict["status"] == VerdictStatus.pass_.value
    assert len(ingest.of_type("scenario.finished")) == 1


async def test_finishing_as_canceled_closes_the_attempts_that_never_ran(
    activities: ScenarioLifecycleActivities, session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, attempts=3)
    run_scenario_id = seeded.run_scenario_ids[0]
    environment = ActivityEnvironment()
    await environment.run(
        activities.begin_scenario_attempt,
        BeginScenarioAttemptInput(run_scenario_id=run_scenario_id, attempt=0),
    )
    await environment.run(
        activities.finish_run_scenario,
        FinishRunScenarioInput(
            run_scenario_id=run_scenario_id,
            status=RunScenarioStatus.canceled,
            verdict=skipped_verdict(SkipReason.canceled),
        ),
    )
    row = await load_run_scenario(session_factory, run_scenario_id)
    assert [entry["status"] for entry in row.attempts] == ["canceled"] * 3


async def test_a_status_that_is_not_final_is_rejected(
    activities: ScenarioLifecycleActivities, session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    with pytest.raises(ApplicationError) as caught:
        await ActivityEnvironment().run(
            activities.finish_run_scenario,
            FinishRunScenarioInput(
                run_scenario_id=seeded.run_scenario_ids[0],
                status=RunScenarioStatus.running,
                verdict=None,
            ),
        )
    assert caught.value.non_retryable is True


async def test_an_unknown_run_scenario_is_a_non_retryable_failure(
    activities: ScenarioLifecycleActivities,
) -> None:
    with pytest.raises(ApplicationError) as caught:
        await ActivityEnvironment().run(
            activities.begin_scenario_attempt,
            BeginScenarioAttemptInput(run_scenario_id=new_id(), attempt=0),
        )
    assert caught.value.non_retryable is True


async def test_skipping_marks_only_queued_scenarios_with_the_reason(
    activities: ScenarioLifecycleActivities,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=3, attempts=2)
    environment = ActivityEnvironment()
    await environment.run(
        activities.begin_scenario_attempt,
        BeginScenarioAttemptInput(run_scenario_id=seeded.run_scenario_ids[0], attempt=0),
    )
    result = await environment.run(
        activities.skip_run_scenarios,
        SkipRunScenariosInput(run_id=seeded.run_id, reason=SkipReason.budget_exceeded),
    )
    assert set(result.run_scenario_ids) == set(seeded.run_scenario_ids[1:])
    rows = await load_run_scenarios(session_factory, seeded.run_id)
    assert [row.status for row in rows] == [
        RunScenarioStatus.running,
        RunScenarioStatus.skipped,
        RunScenarioStatus.skipped,
    ]
    skipped = rows[1]
    assert skipped.skip_reason is SkipReason.budget_exceeded
    assert skipped.verdict is not None
    assert skipped.verdict["status"] == "skipped"
    assert skipped.verdict["skip_reason"] == "budget_exceeded"
    assert [entry["status"] for entry in skipped.attempts] == ["skipped", "skipped"]
    events = ingest.of_type("scenario.finished")
    assert len(events) == 2
    assert events[0].payload["status"] == "skipped"
    assert events[0].payload["attempts"] == {"passed": 0, "failed": 0, "total": 2}


async def test_skipping_twice_skips_nothing_the_second_time(
    activities: ScenarioLifecycleActivities, session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2)
    environment = ActivityEnvironment()
    request = SkipRunScenariosInput(run_id=seeded.run_id, reason=SkipReason.canceled)
    first = await environment.run(activities.skip_run_scenarios, request)
    second = await environment.run(activities.skip_run_scenarios, request)
    assert len(first.run_scenario_ids) == 2
    assert second.run_scenario_ids == []
