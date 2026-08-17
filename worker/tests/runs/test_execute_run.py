import asyncio
import uuid
from collections.abc import Sequence

import pytest
from temporalio.testing import WorkflowEnvironment

from tessa_api.db.models import PlanRow, RunRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import InvariantPack, RunScenarioStatus, RunStatus, ScheduleTier
from tessa_api.schemas.temporal import AttemptResult, DriveAttemptInput
from tessa_worker.settings import WorkerSettings
from tests.runs.harness import (
    ScriptedDrive,
    ScriptedLoop,
    StubPlanning,
    attempt_result,
    run_stack,
)
from tests.runs.support import (
    RecordingIngest,
    SeededRun,
    load_run,
    load_run_scenarios,
    seed_run,
    verdict_status,
)

pytestmark = pytest.mark.integration


async def configure_run(
    session_factory: SessionFactory,
    seeded: SeededRun,
    scenario_ids: Sequence[uuid.UUID] | None = None,
    tier: ScheduleTier | None = None,
    include_api_fuzz: bool = False,
) -> None:
    async with session_factory() as session:
        run = await session.get(RunRow, seeded.run_id)
        plan = await session.get(PlanRow, seeded.plan_id)
        assert run is not None
        assert plan is not None
        snapshot = dict(run.config_snapshot)
        if scenario_ids is not None:
            snapshot["scenario_ids"] = [str(item) for item in scenario_ids]
        if tier is not None:
            snapshot["schedule_tier"] = tier.value
        run.config_snapshot = snapshot
        plan.include_api_fuzz = include_api_fuzz
        await session.commit()


async def test_a_plan_run_plans_coverage_invariants_and_fuzz_then_triages_and_reports(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2)
    await configure_run(session_factory, seeded, include_api_fuzz=True)
    planning = StubPlanning(seeded=seeded)
    loop = ScriptedLoop()
    async with run_stack(
        temporal_env, session_factory, worker_settings, ingest, planning=planning, loop=loop
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert planning.expanded_for == [seeded.plan_id]
    assert loop.frozen == [seeded.run_id]
    assert loop.invariant_scenarios_for == [seeded.run_id]
    assert loop.fuzzed == [seeded.run_id]
    assert result.reason is not None
    assert loop.fuzz_notice in result.reason
    assert len(loop.evaluated) == 2
    assert {tuple(item.pack_ids) for item in loop.evaluated} == {tuple(InvariantPack)}
    assert loop.triaged == [seeded.run_id]
    assert loop.resolved == [seeded.run_id]
    assert loop.flakiness == [seeded.run_id]
    assert loop.reported == [seeded.run_id]
    assert loop.notified == [seeded.run_id]


async def test_a_subset_run_skips_coverage_planning_invariant_scenarios_and_fuzz(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2)
    await configure_run(
        session_factory, seeded, scenario_ids=seeded.scenario_ids[:1], include_api_fuzz=True
    )
    planning = StubPlanning(seeded=seeded, cell_ids=[seeded.plan_id])
    loop = ScriptedLoop()
    async with run_stack(
        temporal_env, session_factory, worker_settings, ingest, planning=planning, loop=loop
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert result.reason is None
    assert planning.expanded_for == []
    assert planning.generated == []
    assert planning.created_for == [seeded.run_id]
    assert loop.invariant_scenarios_for == []
    assert loop.fuzzed == []
    assert loop.frozen == [seeded.run_id]
    assert loop.triaged == [seeded.run_id]
    assert loop.reported == [seeded.run_id]


async def test_a_commit_tier_run_skips_invariant_scenarios_and_fuzz_but_plans_coverage(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    await configure_run(session_factory, seeded, tier=ScheduleTier.commit, include_api_fuzz=True)
    planning = StubPlanning(seeded=seeded)
    loop = ScriptedLoop()
    async with run_stack(
        temporal_env, session_factory, worker_settings, ingest, planning=planning, loop=loop
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert planning.expanded_for == [seeded.plan_id]
    assert loop.invariant_scenarios_for == []
    assert loop.fuzzed == []
    assert loop.triaged == [seeded.run_id]


async def test_a_run_its_parent_owns_keeps_its_status_and_neither_triages_nor_reports(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    loop = ScriptedLoop()
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        planning=StubPlanning(seeded=seeded),
        loop=loop,
    ) as stack:
        result = await stack.run(seeded.run_id, owns_run=False)
    assert result.status is RunStatus.completed
    assert result.counters.pass_ == 1
    assert loop.triaged == []
    assert loop.reported == []
    assert "run.finished" not in ingest.types
    assert (await load_run(session_factory, seeded.run_id)).status is RunStatus.running


async def test_a_run_of_passing_scenarios_completes_with_counters_and_events(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=3)
    planning = StubPlanning(seeded=seeded)
    async with run_stack(
        temporal_env, session_factory, worker_settings, ingest, planning=planning
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert result.counters.scenarios_total == 3
    assert result.counters.scenarios_done == 3
    assert result.counters.pass_ == 3
    assert result.spent_usd == 0.0
    row = await load_run(session_factory, seeded.run_id)
    assert row.status is RunStatus.completed
    assert row.finished_at is not None
    assert row.counters["pass"] == 3
    scenarios = await load_run_scenarios(session_factory, seeded.run_id)
    assert [scenario.status for scenario in scenarios] == [RunScenarioStatus.finished] * 3
    assert [verdict_status(scenario) for scenario in scenarios] == ["pass"] * 3
    assert ingest.status_changes() == [
        ("queued", "planning", None),
        ("planning", "seeding", None),
        ("seeding", "running", "seed_unverified"),
        ("running", "completed", None),
    ]
    assert len(ingest.of_type("scenario.started")) == 3
    assert len(ingest.of_type("scenario.verdict")) == 3
    assert len(ingest.of_type("scenario.finished")) == 3
    assert ingest.of_type("run.progress")
    assert ingest.of_type("budget.updated")
    assert ingest.types[-2:] == ["run.finished", "dashboard.invalidate"]
    seqs = ingest.seqs_for(seeded.run_id)
    assert seqs == list(range(1, len(seqs) + 1))


async def test_planning_creates_the_run_scenarios_before_anything_runs(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2)
    planning = StubPlanning(seeded=seeded, cell_ids=[seeded.plan_id, seeded.run_id])
    async with run_stack(
        temporal_env, session_factory, worker_settings, ingest, planning=planning
    ) as stack:
        await stack.run(seeded.run_id)
    assert planning.created_for == [seeded.run_id]
    assert len(planning.generated) == 2
    assert len(planning.validated) == 2


async def test_the_concurrency_cap_is_respected(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=6)

    async def slow(request: DriveAttemptInput) -> AttemptResult:
        await asyncio.sleep(0.15)
        return attempt_result()

    drive = ScriptedDrive(script=slow)
    settings = worker_settings.model_copy(update={"run_max_concurrency": 2})
    async with run_stack(
        temporal_env,
        session_factory,
        settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert result.counters.pass_ == 6
    assert len(drive.calls) == 6
    assert drive.peak == 2
