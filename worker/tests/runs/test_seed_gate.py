import uuid
from collections.abc import Callable
from typing import Any

import pytest
from temporalio import activity
from temporalio.testing import WorkflowEnvironment

from tessa_api.db.models import BundleRow, RunRow, SeedRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import (
    RunScenarioStatus,
    RunStatus,
    SeedHashSource,
    SeedResetStatus,
    SkipReason,
)
from tessa_api.schemas.temporal import (
    EXECUTE_RESET_SCRIPT_ACTIVITY,
    RUN_HASH_COMMAND_ACTIVITY,
    ExecuteResetScriptInput,
    ExecuteResetScriptResult,
    RunHashCommandInput,
    RunHashCommandResult,
)
from tessa_api.services.storage import LocalBundleStore
from tessa_api.services.vault import vault_from_settings
from tessa_worker.activities.seed_gate import SeedGateActivities
from tessa_worker.activities.seeding import SeedingActivities
from tessa_worker.settings import WorkerSettings
from tests.grading.support import manifest_with_feature_invariants
from tests.runs.harness import ScriptedDrive, StubPlanning, run_stack
from tests.runs.support import (
    RecordingIngest,
    SeededRun,
    load_run,
    load_run_scenarios,
    seed_run,
)

pytestmark = pytest.mark.integration

DECLARED = "hash-declared"
OTHER = "hash-other"


class ScriptedSeedScripts(SeedingActivities):
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        observed_hash: str = DECLARED,
        reset_exit_code: int = 0,
    ) -> None:
        super().__init__(
            settings,
            session_factory,
            vault_from_settings(settings),
            LocalBundleStore(settings.data_dir),
        )
        self.observed_hash = observed_hash
        self.reset_exit_code = reset_exit_code
        self.resets: list[uuid.UUID] = []
        self.hashed: list[uuid.UUID] = []

    @activity.defn(name=EXECUTE_RESET_SCRIPT_ACTIVITY)
    async def execute_reset_script(
        self, request: ExecuteResetScriptInput
    ) -> ExecuteResetScriptResult:
        self.resets.append(request.seed_id)
        excerpt = "" if self.reset_exit_code == 0 else "psql: relation rooms does not exist"
        return ExecuteResetScriptResult(exit_code=self.reset_exit_code, output_excerpt=excerpt)

    @activity.defn(name=RUN_HASH_COMMAND_ACTIVITY)
    async def run_hash_command(self, request: RunHashCommandInput) -> RunHashCommandResult:
        self.hashed.append(request.seed_id)
        return RunHashCommandResult(observed_hash=self.observed_hash)


def seed_activities(
    session_factory: SessionFactory, scripts: ScriptedSeedScripts
) -> list[Callable[..., Any]]:
    gate = SeedGateActivities(session_factory)
    return [
        gate.plan_seed_assertion,
        gate.assert_seed,
        scripts.open_seed_run,
        scripts.load_seed_material,
        scripts.execute_reset_script,
        scripts.run_hash_command,
        scripts.record_seed_outcome,
    ]


async def add_seed(
    session_factory: SessionFactory,
    seeded: SeededRun,
    declared_hash: str | None,
    read_only: bool = False,
) -> uuid.UUID:
    async with session_factory() as session:
        bundle = await session.get(BundleRow, seeded.bundle_id)
        run = await session.get(RunRow, seeded.run_id)
        assert bundle is not None
        assert run is not None
        bundle.manifest = manifest_with_feature_invariants()
        run.read_only = read_only
        seed = SeedRow(
            target_id=seeded.target_id,
            bundle_id=seeded.bundle_id,
            version=1,
            declared_hash=declared_hash,
            hash_source=SeedHashSource.bundle,
            reset_script_path="seeds/reset.sh",
            hash_command="bash seeds/hash.sh",
            material_sha256="material",
        )
        session.add(seed)
        await session.commit()
        return seed.id


def running_reason(ingest: RecordingIngest) -> str | None:
    return next(reason for _, status, reason in ingest.status_changes() if status == "running")


async def seed_row(session_factory: SessionFactory, seed_id: uuid.UUID) -> SeedRow:
    async with session_factory() as session:
        row = await session.get(SeedRow, seed_id)
        assert row is not None
        return row


async def test_a_matching_hash_verifies_the_seed_pins_it_and_runs_the_scenarios(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2)
    seed_id = await add_seed(session_factory, seeded, DECLARED)
    scripts = ScriptedSeedScripts(worker_settings, session_factory)
    drive = ScriptedDrive()
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
        seed_activities=seed_activities(session_factory, scripts),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert scripts.hashed == [seed_id]
    assert scripts.resets == []
    assert len(drive.calls) == 2
    assert ("seeding", "running", None) in ingest.status_changes()
    run = await load_run(session_factory, seeded.run_id)
    assert run.config_snapshot["seed_hash"] == DECLARED
    row = await seed_row(session_factory, seed_id)
    assert row.last_reset_status is SeedResetStatus.ok
    assert row.observed_hash == DECLARED
    assert ingest.of_type("seed.progress")


async def test_a_different_hash_fails_the_run_and_skips_every_scenario_as_seed_mismatch(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2)
    seed_id = await add_seed(session_factory, seeded, DECLARED)
    scripts = ScriptedSeedScripts(worker_settings, session_factory, observed_hash=OTHER)
    drive = ScriptedDrive()
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
        seed_activities=seed_activities(session_factory, scripts),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.failed
    assert drive.calls == []
    rows = await load_run_scenarios(session_factory, seeded.run_id)
    assert {row.status for row in rows} == {RunScenarioStatus.skipped}
    assert {row.skip_reason for row in rows} == {SkipReason.seed_mismatch}
    previous, status, reason = ingest.status_changes()[-1]
    assert (previous, status) == ("seeding", "failed")
    assert reason is not None
    assert OTHER in reason
    assert DECLARED in reason
    assert (await seed_row(session_factory, seed_id)).last_reset_status is SeedResetStatus.mismatch
    assert (await load_run(session_factory, seeded.run_id)).config_snapshot["seed_hash"] is None


async def test_a_seed_without_an_expected_hash_runs_unverified_without_hashing(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    await add_seed(session_factory, seeded, None)
    scripts = ScriptedSeedScripts(worker_settings, session_factory)
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        planning=StubPlanning(seeded=seeded),
        seed_activities=seed_activities(session_factory, scripts),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert scripts.hashed == []
    reason = running_reason(ingest)
    assert reason is not None
    assert reason.startswith("seed_unverified: the seed has no expected hash yet")


async def test_a_requested_reset_runs_the_script_and_pins_the_first_hash(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    seed_id = await add_seed(session_factory, seeded, None)
    scripts = ScriptedSeedScripts(worker_settings, session_factory, observed_hash=OTHER)
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        planning=StubPlanning(seeded=seeded),
        seed_activities=seed_activities(session_factory, scripts),
    ) as stack:
        result = await stack.run(seeded.run_id, reset_seed=True)
    assert result.status is RunStatus.completed
    assert scripts.resets == [seed_id]
    assert scripts.hashed == [seed_id]
    row = await seed_row(session_factory, seed_id)
    assert row.declared_hash == OTHER
    assert row.hash_source is SeedHashSource.first_reset
    assert (await load_run(session_factory, seeded.run_id)).config_snapshot["seed_hash"] == OTHER


async def test_a_failing_reset_script_fails_the_run_before_any_scenario(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=2)
    seed_id = await add_seed(session_factory, seeded, DECLARED)
    scripts = ScriptedSeedScripts(worker_settings, session_factory, reset_exit_code=1)
    drive = ScriptedDrive()
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        drive=drive,
        planning=StubPlanning(seeded=seeded),
        seed_activities=seed_activities(session_factory, scripts),
    ) as stack:
        result = await stack.run(seeded.run_id, reset_seed=True)
    assert result.status is RunStatus.failed
    assert scripts.hashed == []
    assert drive.calls == []
    rows = await load_run_scenarios(session_factory, seeded.run_id)
    assert {row.skip_reason for row in rows} == {SkipReason.precondition_failed}
    _, _, reason = ingest.status_changes()[-1]
    assert reason is not None
    assert "script_failed" in reason
    assert (await seed_row(session_factory, seed_id)).last_reset_status is SeedResetStatus.failed


async def test_a_reset_is_refused_on_a_read_only_run_and_no_script_runs(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    await add_seed(session_factory, seeded, DECLARED, read_only=True)
    scripts = ScriptedSeedScripts(worker_settings, session_factory)
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        planning=StubPlanning(seeded=seeded),
        seed_activities=seed_activities(session_factory, scripts),
    ) as stack:
        result = await stack.run(seeded.run_id, reset_seed=True)
    assert result.status is RunStatus.failed
    assert scripts.resets == []
    assert scripts.hashed == []
    _, _, reason = ingest.status_changes()[-1]
    assert reason is not None
    assert "production" in reason


async def test_a_read_only_run_never_runs_seed_scripts_and_proceeds_unverified(
    temporal_env: WorkflowEnvironment,
    session_factory: SessionFactory,
    worker_settings: WorkerSettings,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    await add_seed(session_factory, seeded, DECLARED, read_only=True)
    scripts = ScriptedSeedScripts(worker_settings, session_factory)
    async with run_stack(
        temporal_env,
        session_factory,
        worker_settings,
        ingest,
        planning=StubPlanning(seeded=seeded),
        seed_activities=seed_activities(session_factory, scripts),
    ) as stack:
        result = await stack.run(seeded.run_id)
    assert result.status is RunStatus.completed
    assert scripts.hashed == []
    assert running_reason(ingest) == "seed_unverified: production runs never execute seed scripts"
