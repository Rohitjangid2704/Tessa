from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import RunRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.runs import ClockSnapshot, RunConfigSnapshot
from tessa_api.services.probe_bank import ProbeBankError
from tessa_api.services.settings_service import ResolvedRunModels, resolve_model_specs
from tessa_worker.activities.clock import CLOCK_PIN_FAILED
from tessa_worker.activities.config_snapshot import (
    RUN_NOT_FOUND,
    lock_unfrozen_run,
    merge_into_config,
)
from tessa_worker.activities.names import FREEZE_RUN_CONFIG
from tessa_worker.activities.run_models import FreezeRunConfigInput, FreezeRunConfigResult
from tessa_worker.settings import WorkerSettings
from tessa_worker.truth.clock import ClockPinError, ClockResolver

PROBE_BANK_INVALID = "probe_bank_invalid"


def missing_run(run_id: UUID) -> ApplicationError:
    return ApplicationError(
        f"run {run_id} does not exist or has no target", type=RUN_NOT_FOUND, non_retryable=True
    )


class RunConfigActivities:
    def __init__(
        self, settings: WorkerSettings, session_factory: SessionFactory, clock: ClockResolver
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.clock = clock

    @activity.defn(name=FREEZE_RUN_CONFIG)
    async def freeze_run_config(self, request: FreezeRunConfigInput) -> FreezeRunConfigResult:
        async with self.session_factory() as session:
            run = await session.get(RunRow, request.run_id)
            if run is None or run.target_id is None:
                raise missing_run(request.run_id)
            target_id, bundle_id = run.target_id, run.bundle_id
            snapshot = RunConfigSnapshot.model_validate(run.config_snapshot)
            pinned, override = snapshot.clock, snapshot.base_url_override
            resolved = await self.resolved_models(session)
        clock = pinned or await self.resolve_clock(target_id, bundle_id, override)
        await self.store(request.run_id, clock, resolved)
        return FreezeRunConfigResult(
            clock=clock, models=resolved.models, probe_bank_version=resolved.probe_bank_version
        )

    async def resolved_models(self, session: AsyncSession) -> ResolvedRunModels:
        try:
            return await resolve_model_specs(session, self.settings)
        except ProbeBankError as error:
            raise ApplicationError(
                f"the probe bank is invalid: {error}", type=PROBE_BANK_INVALID, non_retryable=True
            ) from None

    async def resolve_clock(
        self, target_id: UUID, bundle_id: UUID | None, base_url_override: str | None
    ) -> ClockSnapshot:
        try:
            return await self.clock.resolve(target_id, bundle_id, base_url_override)
        except ClockPinError as error:
            raise ApplicationError(
                error.message, type=CLOCK_PIN_FAILED, non_retryable=not error.retryable
            ) from None

    async def store(self, run_id: UUID, clock: ClockSnapshot, resolved: ResolvedRunModels) -> None:
        async with self.session_factory() as session:
            run = await lock_unfrozen_run(session, run_id)
            merge_into_config(
                run,
                {
                    "clock": clock.model_dump(mode="json"),
                    "models": {
                        role.value: snapshot.model_dump(mode="json")
                        for role, snapshot in resolved.models.items()
                    },
                    "probe_bank_version": resolved.probe_bank_version,
                },
            )
            await session.commit()
