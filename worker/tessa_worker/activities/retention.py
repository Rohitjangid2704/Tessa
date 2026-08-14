import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from temporalio import activity

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.retention import (
    RetentionCutoffs,
    RetentionSweepCounts,
    RetentionSweepResult,
)
from tessa_api.services.retention import load_policy, record_sweep, retention_cutoffs
from tessa_api.services.retention_pins import compute_pin_set, load_pin_inputs
from tessa_api.services.retention_sweep import (
    purge_artifact_slice,
    purge_run_event_batch,
    purge_step_payload_batch,
)
from tessa_api.services.storage import Storage, StorageKey, storage_from_settings
from tessa_api.settings import StrictSettings
from tessa_worker.activities.retention_models import (
    LOAD_RETENTION_PLAN,
    PURGE_ARTIFACTS,
    PURGE_RUN_EVENTS,
    PURGE_STEP_PAYLOADS,
    RECORD_RETENTION_SWEEP,
    RETENTION_ARTIFACT_SCAN_LIMIT,
    RETENTION_CALL_MAX_BATCHES,
    RETENTION_CALL_MAX_SECONDS,
    PurgeArtifactsInput,
    PurgeArtifactsResult,
    PurgeBatchInput,
    PurgeBatchResult,
)

logger = logging.getLogger("tessa_worker.retention")

BatchPurge = Callable[[SessionFactory, datetime], Awaitable[int]]


class RetentionActivities:
    def __init__(
        self,
        settings: StrictSettings,
        session_factory: SessionFactory,
        storage: Storage | None = None,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.storage = storage or storage_from_settings(settings)

    @activity.defn(name=LOAD_RETENTION_PLAN)
    async def load_retention_plan(self) -> RetentionCutoffs:
        async with self.session_factory() as session:
            policy = await load_policy(session, self.settings)
        return retention_cutoffs(policy, datetime.now(UTC))

    @activity.defn(name=PURGE_STEP_PAYLOADS)
    async def purge_step_payloads(self, request: PurgeBatchInput) -> PurgeBatchResult:
        return await self.purge_in_batches(request.before, purge_step_payload_batch)

    @activity.defn(name=PURGE_RUN_EVENTS)
    async def purge_run_events(self, request: PurgeBatchInput) -> PurgeBatchResult:
        return await self.purge_in_batches(request.before, purge_run_event_batch)

    @activity.defn(name=PURGE_ARTIFACTS)
    async def purge_artifacts(self, request: PurgeArtifactsInput) -> PurgeArtifactsResult:
        async with self.session_factory() as session:
            pinned = compute_pin_set(await load_pin_inputs(session, request.before))
        outcome = await purge_artifact_slice(
            self.storage,
            pinned,
            request.before,
            None if request.after is None else StorageKey(request.after),
            RETENTION_ARTIFACT_SCAN_LIMIT,
            RETENTION_CALL_MAX_SECONDS,
            activity.heartbeat,
        )
        logger.info(
            "retention_artifacts_slice",
            extra={
                "scanned": outcome.scanned,
                "deleted": outcome.deleted,
                "pinned": len(pinned),
                "finished": outcome.finished,
            },
        )
        return PurgeArtifactsResult(
            deleted=outcome.deleted,
            scanned=outcome.scanned,
            after=outcome.last_key,
            more=not outcome.finished,
        )

    @activity.defn(name=RECORD_RETENTION_SWEEP)
    async def record_retention_sweep(self, counts: RetentionSweepCounts) -> RetentionSweepResult:
        async with self.session_factory() as session:
            result = await record_sweep(session, counts, datetime.now(UTC))
            await session.commit()
        logger.info(
            "retention_sweep_recorded",
            extra={
                "deleted_steps": result.deleted_steps,
                "deleted_artifacts": result.deleted_artifacts,
                "deleted_events": result.deleted_events,
            },
        )
        return result

    async def purge_in_batches(self, before: datetime, purge: BatchPurge) -> PurgeBatchResult:
        started = time.monotonic()
        total = 0
        for _ in range(RETENTION_CALL_MAX_BATCHES):
            purged = await purge(self.session_factory, before)
            total += purged
            activity.heartbeat(total)
            if purged == 0:
                return PurgeBatchResult(purged=total, more=False)
            if time.monotonic() - started >= RETENTION_CALL_MAX_SECONDS:
                return PurgeBatchResult(purged=total, more=True)
        return PurgeBatchResult(purged=total, more=True)
