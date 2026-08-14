import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import BundleRow, RunRow, SeedRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import RunKind, SeedHashSource
from tessa_api.schemas.temporal import (
    EXECUTE_RESET_SCRIPT_ACTIVITY,
    LOAD_SEED_MATERIAL_ACTIVITY,
    RUN_HASH_COMMAND_ACTIVITY,
    ExecuteResetScriptInput,
    ExecuteResetScriptResult,
    LoadSeedMaterialInput,
    LoadSeedMaterialResult,
    RunHashCommandInput,
    RunHashCommandResult,
)
from tessa_api.services.storage import BundleStore
from tessa_api.services.vault import Vault
from tessa_worker.activities.names import OPEN_SEED_RUN, RECORD_SEED_OUTCOME
from tessa_worker.activities.seeding_models import (
    OpenSeedRunInput,
    OpenSeedRunResult,
    RecordSeedOutcomeInput,
    RecordSeedOutcomeResult,
)
from tessa_worker.adapters.auth import load_environment
from tessa_worker.settings import WorkerSettings
from tessa_worker.truth.environment import SeedEnvironment, seed_environment
from tessa_worker.truth.errors import SeedFailure
from tessa_worker.truth.hash_command import HashCommandRunner
from tessa_worker.truth.material import SeedFiles, read_seed_files
from tessa_worker.truth.seed_runner import SeedRunner

HEARTBEAT_INTERVAL_SECONDS = 2.0
SEED_NOT_FOUND = "seed_not_found"
SEED_RUN_MISMATCH = "seed_run_mismatch"
BUNDLE_UNREADABLE = "bundle_unreadable"


@dataclass(frozen=True, slots=True)
class LoadedSeed:
    files: SeedFiles
    environment: SeedEnvironment


def permanent_error(message: str, error_type: str) -> ApplicationError:
    return ApplicationError(message, type=error_type, non_retryable=True)


def failure_error(failure: SeedFailure) -> ApplicationError:
    return permanent_error(failure.message, failure.code.value)


async def beat() -> None:
    while True:
        activity.heartbeat()
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)


@asynccontextmanager
async def heartbeating() -> AsyncIterator[None]:
    task = asyncio.create_task(beat())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def require_seed(session: AsyncSession, seed_id: UUID) -> SeedRow:
    seed = await session.get(SeedRow, seed_id)
    if seed is None:
        raise permanent_error(f"seed {seed_id} does not exist", SEED_NOT_FOUND)
    return seed


class SeedingActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        vault: Vault,
        bundles: BundleStore,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.vault = vault
        self.bundles = bundles
        self.runner = SeedRunner(settings.seed_script_timeout_seconds)
        self.hashes = HashCommandRunner(settings.seed_script_timeout_seconds)

    async def load_seed(self, seed_id: UUID) -> LoadedSeed:
        async with self.session_factory() as session:
            seed = await require_seed(session, seed_id)
            bundle = await session.get(BundleRow, seed.bundle_id)
            if bundle is None or bundle.manifest is None:
                raise permanent_error(
                    f"the bundle of seed {seed_id} has no manifest", BUNDLE_UNREADABLE
                )
            manifest = BundleManifest.model_validate(bundle.manifest)
            resolved = await load_environment(session, self.vault, seed.target_id)
        files = await read_seed_files(self.bundles, bundle)
        return LoadedSeed(
            files=SeedFiles(
                reset_script_path=seed.reset_script_path,
                hash_command=seed.hash_command,
                dsn_env=manifest.seeds.dsn_env if manifest.seeds is not None else None,
                files=files,
            ),
            environment=seed_environment(resolved, [item.name for item in manifest.environment]),
        )

    @activity.defn(name=LOAD_SEED_MATERIAL_ACTIVITY)
    async def load_seed_material(self, request: LoadSeedMaterialInput) -> LoadSeedMaterialResult:
        async with self.session_factory() as session:
            seed = await require_seed(session, request.seed_id)
        return LoadSeedMaterialResult(
            reset_script_ref=seed.reset_script_path,
            hash_command_ref=f"seed:{seed.id}:hash_command" if seed.hash_command else None,
            script_timeout_seconds=self.settings.seed_script_timeout_seconds,
        )

    @activity.defn(name=OPEN_SEED_RUN)
    async def open_seed_run(self, request: OpenSeedRunInput) -> OpenSeedRunResult:
        async with self.session_factory() as session:
            seed = await require_seed(session, request.seed_id)
            run = await session.get(RunRow, request.run_id)
        if run is None:
            raise permanent_error(f"run {request.run_id} does not exist", SEED_RUN_MISMATCH)
        if run.target_id != seed.target_id:
            raise permanent_error(
                f"run {request.run_id} belongs to another target than seed {seed.id}",
                SEED_RUN_MISMATCH,
            )
        return OpenSeedRunResult(
            owns_run=run.kind is RunKind.seed,
            declared_hash=seed.declared_hash,
            hash_source=seed.hash_source,
        )

    @activity.defn(name=EXECUTE_RESET_SCRIPT_ACTIVITY)
    async def execute_reset_script(
        self, request: ExecuteResetScriptInput
    ) -> ExecuteResetScriptResult:
        try:
            loaded = await self.load_seed(request.seed_id)
            async with heartbeating():
                outcome = await self.runner.reset(loaded.files, loaded.environment)
        except SeedFailure as failure:
            raise failure_error(failure) from None
        return ExecuteResetScriptResult(
            exit_code=outcome.exit_code, output_excerpt=outcome.output_excerpt
        )

    @activity.defn(name=RUN_HASH_COMMAND_ACTIVITY)
    async def run_hash_command(self, request: RunHashCommandInput) -> RunHashCommandResult:
        try:
            loaded = await self.load_seed(request.seed_id)
            async with heartbeating():
                observed = await self.hashes.run(loaded.files, loaded.environment)
        except SeedFailure as failure:
            raise failure_error(failure) from None
        return RunHashCommandResult(observed_hash=observed)

    @activity.defn(name=RECORD_SEED_OUTCOME)
    async def record_seed_outcome(self, request: RecordSeedOutcomeInput) -> RecordSeedOutcomeResult:
        async with self.session_factory() as session:
            seed = await session.get(SeedRow, request.seed_id, with_for_update=True)
            if seed is None:
                raise permanent_error(f"seed {request.seed_id} does not exist", SEED_NOT_FOUND)
            seed.last_reset_at = datetime.now(UTC)
            seed.last_reset_status = request.status
            seed.last_reset_run_id = request.run_id
            if request.observed_hash is not None:
                seed.observed_hash = request.observed_hash
            if request.pin_first_reset and seed.declared_hash is None and request.observed_hash:
                seed.declared_hash = request.observed_hash
                seed.hash_source = SeedHashSource.first_reset
            result = RecordSeedOutcomeResult(
                declared_hash=seed.declared_hash, hash_source=seed.hash_source
            )
            await session.commit()
        return result
