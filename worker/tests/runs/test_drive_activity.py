import asyncio
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import select
from temporalio.testing import ActivityEnvironment

from tessa_api.db.models import BrowserSessionRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import (
    AdapterKind,
    ArtifactKind,
    BrowserSessionStatus,
    RunScenarioStatus,
    SkipReason,
    Tier0Check,
    VerdictStatus,
)
from tessa_api.schemas.scenario import ScenarioStep
from tessa_api.schemas.steps import Tier0Failure
from tessa_api.schemas.temporal import AttemptResult, DriveAttemptInput
from tessa_api.services.artifact_store import InMemoryArtifactStore
from tessa_worker.activities.drive import DriveActivities, StepFinding, compose_attempt_verdict
from tessa_worker.activities.drive_ports import AdapterOpenError, StepAssessment
from tessa_worker.adapters.base import StepRecord
from tessa_worker.checks.tier0 import evaluate_tier0
from tessa_worker.event_client import EventClient
from tessa_worker.settings import WorkerSettings
from tessa_worker.verdicts import fail_verdict, skipped_verdict, uncertain_verdict
from tests.runs.drive_support import (
    SECRET,
    FakeAdapter,
    FakeOpener,
    RecordingHooks,
    browser_record,
    http_record,
    produced,
    write_file,
)
from tests.runs.support import RecordingIngest, SeededRun, load_steps, seed_run

pytestmark = pytest.mark.integration

HEARTBEAT_SECONDS = 0.05
ENOUGH_HEARTBEATS = 4


class DriveRig:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        event_client: EventClient,
        opener: FakeOpener,
        store: InMemoryArtifactStore,
        hooks: RecordingHooks | None = None,
    ) -> None:
        self.opener = opener
        self.store = store
        self.heartbeats: list[Any] = []
        self.enough_heartbeats = asyncio.Event()
        self.activities = DriveActivities(
            settings,
            session_factory,
            event_client,
            opener,
            store,
            evaluate_tier0,
            hooks,
            heartbeat_interval_seconds=HEARTBEAT_SECONDS,
        )

    def environment(self) -> ActivityEnvironment:
        environment = ActivityEnvironment()
        environment.on_heartbeat = self.record_heartbeat
        return environment

    def record_heartbeat(self, *details: Any) -> None:
        self.heartbeats.append(details)
        if len(self.heartbeats) >= ENOUGH_HEARTBEATS:
            self.enough_heartbeats.set()

    async def drive(self, seeded: SeededRun, attempt: int = 0) -> AttemptResult:
        request = DriveAttemptInput(
            run_id=seeded.run_id,
            run_scenario_id=seeded.run_scenario_ids[0],
            attempt=attempt,
            read_only=False,
        )
        result: AttemptResult = await self.environment().run(
            self.activities.drive_scenario_attempt, request
        )
        return result


@pytest.fixture
def store() -> InMemoryArtifactStore:
    return InMemoryArtifactStore()


@pytest.fixture
def make_rig(
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    event_client: EventClient,
    store: InMemoryArtifactStore,
) -> Callable[..., DriveRig]:
    def build(
        adapter: FakeAdapter | None = None, hooks: RecordingHooks | None = None, **options: Any
    ) -> DriveRig:
        opener = FakeOpener(adapter=adapter or FakeAdapter(), **options)
        return DriveRig(worker_settings, session_factory, event_client, opener, store, hooks)

    return build


async def test_a_passing_attempt_records_every_step_and_announces_it(
    make_rig: Callable[..., DriveRig],
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, steps_per_scenario=2)
    adapter = FakeAdapter(
        records=[
            http_record("GET /items/1", cost_usd=0.01),
            http_record("GET /items/2", cost_usd=0.02),
        ]
    )
    rig = make_rig(adapter)
    result = await rig.drive(seeded)
    assert result.status is RunScenarioStatus.finished
    assert result.verdict is not None
    assert result.verdict.status is VerdictStatus.pass_
    assert result.steps_recorded == 2
    assert result.cost_usd == pytest.approx(0.03)
    assert result.browser_session_id is None
    assert result.error is None
    assert adapter.closed == 1
    rows = await load_steps(session_factory, seeded.run_id)
    assert [(row.attempt, row.index, row.label) for row in rows] == [
        (0, 0, "GET /items/1"),
        (0, 1, "GET /items/2"),
    ]
    first = rows[0]
    assert first.adapter is AdapterKind.http
    assert first.request is not None
    assert first.request["kind"] == "http"
    assert first.response is not None
    assert first.response["status"] == 200
    assert first.tier0 == {"passed": True, "failures": []}
    assert first.ok is True
    assert first.tier0_failure_count == 0
    assert first.screenshot_count == 0
    assert float(first.cost_usd) == pytest.approx(0.01)
    events = ingest.of_type("step.recorded")
    assert [event.payload["index"] for event in events] == [0, 1]
    assert events[0].payload["step_id"] == str(first.id)
    assert events[0].payload["run_scenario_id"] == str(seeded.run_scenario_ids[0])
    assert events[0].payload["adapter"] == "http"
    assert events[0].payload["tier0_failure_count"] == 0
    assert ingest.of_type("browser_session.started") == []


async def test_a_tier0_failure_fails_the_attempt_and_the_next_steps_still_run(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, steps_per_scenario=2)
    adapter = FakeAdapter(
        records=[http_record("GET /items/1", status=500), http_record("GET /items/2")]
    )
    result = await make_rig(adapter).drive(seeded)
    assert result.status is RunScenarioStatus.finished
    assert result.verdict is not None
    assert result.verdict.status is VerdictStatus.fail
    assert result.verdict.reason_code == "tier0_failed"
    assert result.verdict.reason is not None
    assert result.verdict.reason.startswith("step 1 (GET /items/1): status")
    assert len(adapter.driven) == 2
    rows = await load_steps(session_factory, seeded.run_id)
    assert rows[0].tier0["passed"] is False
    assert rows[0].tier0["failures"][0]["check"] == "status"
    assert rows[0].tier0_failure_count == 1
    assert rows[1].tier0["passed"] is True


async def test_a_step_the_adapter_could_not_complete_stops_the_attempt(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, steps_per_scenario=3)
    adapter = FakeAdapter(
        records=[
            http_record("GET /items/1"),
            http_record("GET /items/2", ok=False, error="connection refused"),
            http_record("GET /items/3"),
        ]
    )
    result = await make_rig(adapter).drive(seeded)
    assert result.verdict is not None
    assert result.verdict.status is VerdictStatus.fail
    assert result.verdict.reason_code == "step_not_completed"
    assert "connection refused" in (result.verdict.reason or "")
    assert len(adapter.driven) == 2
    assert result.steps_recorded == 2


async def test_an_adapter_exception_becomes_an_errored_attempt_with_a_redacted_reason(
    make_rig: Callable[..., DriveRig],
    session_factory: SessionFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.ERROR)
    seeded = await seed_run(session_factory, scenario_count=1, steps_per_scenario=2)

    async def explode(step: ScenarioStep, index: int) -> StepRecord:
        if index == 0:
            return http_record("GET /items/1")
        raise RuntimeError(f"request with token {SECRET} was reset")

    adapter = FakeAdapter(script=explode)
    result = await make_rig(adapter).drive(seeded)
    assert result.status is RunScenarioStatus.errored
    assert result.error is not None
    assert SECRET not in result.error
    assert "${API_TOKEN}" in result.error
    assert result.verdict is not None
    assert result.verdict.status is VerdictStatus.uncertain
    assert result.verdict.reason_code == "attempt_errored"
    assert result.steps_recorded == 1
    assert adapter.closed == 1
    assert "drive_attempt_failed" in caplog.text
    assert SECRET not in caplog.text


async def test_an_adapter_that_cannot_be_opened_errors_the_attempt(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    rig = make_rig(failure=RuntimeError("no credentials for role staff"))
    result = await rig.drive(seeded)
    assert result.status is RunScenarioStatus.errored
    assert result.error == "RuntimeError: no credentials for role staff"
    assert result.steps_recorded == 0
    assert await load_steps(session_factory, seeded.run_id) == []


async def test_an_interface_kind_without_an_adapter_skips_the_attempt_as_adapter_unsupported(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    rig = make_rig(
        failure=AdapterOpenError(
            "UnsupportedAdapterError: no adapter is registered for interface kind websocket",
            SkipReason.adapter_unsupported,
        )
    )
    result = await rig.drive(seeded)
    assert result.status is RunScenarioStatus.skipped
    assert result.verdict is not None
    assert result.verdict.status is VerdictStatus.skipped
    assert result.verdict.skip_reason is SkipReason.adapter_unsupported
    assert "websocket" in (result.verdict.reason or "")
    assert await load_steps(session_factory, seeded.run_id) == []


async def test_artifacts_are_filed_in_the_store_and_the_local_files_removed(
    make_rig: Callable[..., DriveRig],
    session_factory: SessionFactory,
    store: InMemoryArtifactStore,
    tmp_path: Path,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    screenshot = write_file(tmp_path, "shot.png", b"png-bytes")
    adapter = FakeAdapter(
        records=[
            http_record(
                artifacts=[
                    produced(screenshot, ArtifactKind.screenshot, "image/png"),
                ]
            )
        ]
    )
    await make_rig(adapter).drive(seeded)
    [row] = await load_steps(session_factory, seeded.run_id)
    [filed] = row.artifacts
    assert filed["kind"] == "screenshot"
    assert filed["mime"] == "image/png"
    assert filed["size_bytes"] == len(b"png-bytes")
    assert row.screenshot_count == 1
    stored_artifact = await store.info(UUID(filed["id"]))
    assert stored_artifact.size_bytes == len(b"png-bytes")
    assert not screenshot.exists()


async def test_a_browser_attempt_opens_and_closes_a_session_with_its_recording_and_trace(
    make_rig: Callable[..., DriveRig],
    session_factory: SessionFactory,
    ingest: RecordingIngest,
    store: InMemoryArtifactStore,
    tmp_path: Path,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, adapter="browser")
    adapter = FakeAdapter(
        kind=AdapterKind.browser,
        records=[browser_record(url="http://target.test/page/1")],
        session_files=[
            produced(
                write_file(tmp_path, "rec.webm", b"video"), ArtifactKind.recording, "video/webm"
            ),
            produced(
                write_file(tmp_path, "trace.zip", b"zip"), ArtifactKind.trace, "application/zip"
            ),
        ],
    )
    rig = make_rig(adapter)
    result = await rig.drive(seeded)
    assert result.browser_session_id is not None
    assert rig.opener.requests[0].browser_session_id == result.browser_session_id
    async with session_factory() as session:
        sessions = list(await session.scalars(select(BrowserSessionRow)))
    [stored] = sessions
    assert stored.id == result.browser_session_id
    assert stored.status is BrowserSessionStatus.ended
    assert stored.viewport == {"width": 1280, "height": 720}
    assert stored.last_url == "http://target.test/page/1"
    assert stored.ended_at is not None
    assert stored.recording is not None
    assert stored.recording["kind"] == "recording"
    assert stored.trace is not None
    assert stored.trace["kind"] == "trace"
    assert (await store.info(UUID(stored.recording["id"]))).size_bytes == len(b"video")
    [started] = ingest.of_type("browser_session.started")
    [ended] = ingest.of_type("browser_session.ended")
    assert started.payload["browser_session_id"] == str(result.browser_session_id)
    assert started.payload["viewport"] == {"width": 1280, "height": 720}
    assert started.payload["scenario_title"] == "Scenario 1"
    assert ended.payload["has_recording"] is True
    assert ended.payload["has_trace"] is True
    assert ingest.types.index("browser_session.started") < ingest.types.index("step.recorded")
    assert ingest.types.index("step.recorded") < ingest.types.index("browser_session.ended")


async def test_cancelling_the_activity_closes_the_adapter_and_ends_the_session(
    make_rig: Callable[..., DriveRig],
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(
        session_factory, scenario_count=1, steps_per_scenario=2, adapter="browser"
    )
    entered = asyncio.Event()

    async def block(step: ScenarioStep, index: int) -> StepRecord:
        if index == 0:
            return browser_record()
        entered.set()
        await asyncio.sleep(60)
        return browser_record()

    adapter = FakeAdapter(kind=AdapterKind.browser, script=block)
    rig = make_rig(adapter)
    request = DriveAttemptInput(
        run_id=seeded.run_id,
        run_scenario_id=seeded.run_scenario_ids[0],
        attempt=0,
        read_only=False,
    )
    environment = rig.environment()
    task = asyncio.create_task(environment.run(rig.activities.drive_scenario_attempt, request))
    await asyncio.wait_for(entered.wait(), timeout=10)
    environment.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert adapter.closed == 1
    async with session_factory() as session:
        [stored] = list(await session.scalars(select(BrowserSessionRow)))
    assert stored.status is BrowserSessionStatus.ended
    assert len(ingest.of_type("browser_session.ended")) == 1
    assert len(ingest.of_type("step.recorded")) == 1


async def test_the_activity_heartbeats_while_a_step_is_running(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)

    rig = make_rig()

    async def slow_step(step: ScenarioStep, index: int) -> StepRecord:
        await asyncio.wait_for(rig.enough_heartbeats.wait(), timeout=30)
        return http_record()

    rig.opener.adapter.script = slow_step
    await rig.drive(seeded)
    assert len(rig.heartbeats) >= ENOUGH_HEARTBEATS
    assert rig.heartbeats[0] == ({"step_index": -1, "steps_recorded": 0},)
    assert rig.heartbeats[-1][0]["step_index"] == 0


async def test_a_scenario_that_outlives_its_timeout_fails_with_the_timeout_reason(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, scenario_timeout_seconds=1)

    async def hang(step: ScenarioStep, index: int) -> StepRecord:
        await asyncio.sleep(30)
        return http_record()

    adapter = FakeAdapter(script=hang)
    result = await make_rig(adapter).drive(seeded)
    assert result.status is RunScenarioStatus.finished
    assert result.verdict is not None
    assert result.verdict.status is VerdictStatus.fail
    assert result.verdict.reason_code == "scenario_timeout"
    assert adapter.closed == 1


async def test_driving_the_same_attempt_again_updates_the_step_rows_in_place(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    first_rig = make_rig(FakeAdapter(records=[http_record("first", status=500)]))
    await first_rig.drive(seeded)
    [before] = await load_steps(session_factory, seeded.run_id)
    second_rig = make_rig(FakeAdapter(records=[http_record("second")]))
    await second_rig.drive(seeded)
    [after] = await load_steps(session_factory, seeded.run_id)
    assert after.id == before.id
    assert after.label == "second"
    assert after.tier0["passed"] is True


async def test_each_attempt_has_its_own_step_rows(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, attempts=2)
    rig = make_rig()
    await rig.drive(seeded, attempt=0)
    await rig.drive(seeded, attempt=1)
    rows = await load_steps(session_factory, seeded.run_id)
    assert [(row.attempt, row.index) for row in rows] == [(0, 0), (1, 0)]


async def test_a_missing_run_scenario_errors_the_attempt(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    request = DriveAttemptInput(
        run_id=seeded.run_id, run_scenario_id=seeded.run_id, attempt=0, read_only=False
    )
    rig = make_rig()
    result: AttemptResult = await ActivityEnvironment().run(
        rig.activities.drive_scenario_attempt, request
    )
    assert result.status is RunScenarioStatus.errored
    assert result.error == "the run or the run scenario no longer exists"


async def test_a_hook_can_halt_the_attempt_before_a_step_is_driven(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, steps_per_scenario=2)
    halt = skipped_verdict(SkipReason.precondition_failed, "oracle open_issues is not approved")
    hooks = RecordingHooks(halt_at={1: halt})
    adapter = FakeAdapter()
    result = await make_rig(adapter, hooks).drive(seeded)
    assert result.status is RunScenarioStatus.skipped
    assert result.verdict == halt
    assert len(adapter.driven) == 1
    assert hooks.before == [0, 1]
    assert hooks.after == [0]
    assert result.steps_recorded == 1


async def test_a_hook_halting_with_uncertain_finishes_the_attempt_uncertain(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    halt = uncertain_verdict("oracle_error", "the oracle query failed")
    result = await make_rig(hooks=RecordingHooks(halt_at={0: halt})).drive(seeded)
    assert result.status is RunScenarioStatus.finished
    assert result.verdict == halt


async def test_a_hook_verdict_of_fail_beats_a_clean_tier0_result(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    mismatch = fail_verdict("db row missing", "db_mismatch")
    hooks = RecordingHooks(
        assessments={
            0: StepAssessment(
                verdict=mismatch,
                failures=(
                    Tier0Failure(
                        check=Tier0Check.fields, message="row missing", expected=1, actual=0
                    ),
                ),
            )
        }
    )
    result = await make_rig(hooks=hooks).drive(seeded)
    assert result.verdict == mismatch
    [row] = await load_steps(session_factory, seeded.run_id)
    assert row.tier0["passed"] is False
    assert row.tier0_failure_count == 1


async def test_the_after_step_hook_gets_the_id_of_the_stored_step_and_can_read_it(
    make_rig: Callable[..., DriveRig],
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, steps_per_scenario=2)
    stored_labels: list[str] = []

    async def read_back(step_id: UUID) -> None:
        async with session_factory() as session:
            row = await session.get(StepRow, step_id)
            assert row is not None
            stored_labels.append(row.label)

    hooks = RecordingHooks(inspect_step=read_back)
    adapter = FakeAdapter(records=[http_record("first"), http_record("second")])
    await make_rig(adapter, hooks).drive(seeded)
    rows = await load_steps(session_factory, seeded.run_id)
    assert hooks.step_ids == [row.id for row in rows]
    assert stored_labels == ["first", "second"]
    assert [event.payload["step_id"] for event in ingest.of_type("step.recorded")] == [
        str(row.id) for row in rows
    ]


async def test_hook_failures_are_merged_into_the_stored_tier0_result_and_the_event(
    make_rig: Callable[..., DriveRig],
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    failure = Tier0Failure(check=Tier0Check.fields, message="row missing", expected=1, actual=0)
    hooks = RecordingHooks(
        assessments={
            0: StepAssessment(
                failures=(failure,), step_columns={"verdict": {"status": "fail", "tier": "code"}}
            )
        }
    )
    await make_rig(hooks=hooks).drive(seeded)
    [row] = await load_steps(session_factory, seeded.run_id)
    assert row.tier0["passed"] is False
    assert [item["message"] for item in row.tier0["failures"]] == ["row missing"]
    assert row.tier0_failure_count == 1
    assert row.verdict == {"status": "fail", "tier": "code"}
    [event] = ingest.of_type("step.recorded")
    assert event.payload["tier0_failure_count"] == 1


async def test_hooks_may_only_set_extra_step_columns(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    hooks = RecordingHooks(columns={0: {"label": "hijacked"}})
    result = await make_rig(hooks=hooks).drive(seeded)
    assert result.status is RunScenarioStatus.errored
    assert result.error is not None
    assert "extra step columns" in result.error


async def test_hook_columns_are_stored_with_the_step(
    make_rig: Callable[..., DriveRig], session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    hooks = RecordingHooks(columns={0: {"verdict": {"status": "pass", "tier": "code"}}})
    result = await make_rig(hooks=hooks).drive(seeded)
    assert result.status is RunScenarioStatus.finished
    [row] = await load_steps(session_factory, seeded.run_id)
    assert row.verdict == {"status": "pass", "tier": "code"}


def test_the_attempt_verdict_names_the_first_failing_step() -> None:
    failure = Tier0Failure(check=Tier0Check.latency, message="too slow", expected=1, actual=2)
    verdict: Verdict = compose_attempt_verdict(
        [
            StepFinding(0, "ok step", True, None, (), None),
            StepFinding(1, "slow step", True, None, (failure,), None),
        ]
    )
    assert verdict.status is VerdictStatus.fail
    assert verdict.reason == "step 2 (slow step): latency: too slow"


async def test_the_session_trace_is_the_first_step_trace_when_the_adapter_files_none(
    make_rig: Callable[..., DriveRig],
    session_factory: SessionFactory,
    ingest: RecordingIngest,
    tmp_path: Path,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1, adapter="browser")
    record = browser_record()
    record.artifacts.append(
        produced(write_file(tmp_path, "chunk.zip", b"chunk"), ArtifactKind.trace, "application/zip")
    )
    adapter = FakeAdapter(kind=AdapterKind.browser, records=[record])
    await make_rig(adapter).drive(seeded)
    async with session_factory() as session:
        [stored] = list(await session.scalars(select(BrowserSessionRow)))
    assert stored.trace is not None
    assert stored.trace["kind"] == "trace"
    assert stored.recording is None
    [ended] = ingest.of_type("browser_session.ended")
    assert (ended.payload["has_recording"], ended.payload["has_trace"]) == (False, True)
