from datetime import UTC, datetime
from uuid import UUID

from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import RunRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import RunCounters
from tessa_api.schemas.enums import CoverageUpdateReason, RunStatus
from tessa_api.schemas.streams import RunFinishedPayload, RunStatusChangedPayload
from tessa_api.schemas.temporal import (
    FINALIZE_RUN_ACTIVITY,
    UPDATE_RUN_STATUS_ACTIVITY,
    FinalizeRunInput,
    FinalizeRunResult,
    UpdateRunStatusInput,
    UpdateRunStatusResult,
)
from tessa_api.services.budget import read_run_spend
from tessa_api.services.coverage_events import coverage_updated_events
from tessa_api.services.dashboard_events import dashboard_invalidate_event
from tessa_api.services.plans import record_cell_verdicts_with_changes
from tessa_api.services.run_counters import read_run_counters
from tessa_api.services.run_stats import freeze_run_stats
from tessa_worker.activities.names import PUBLISH_RUN_PROGRESS
from tessa_worker.activities.run_models import (
    PublishRunProgressInput,
    PublishRunProgressResult,
)
from tessa_worker.event_client import EventClient, build_event, event_payload
from tessa_worker.metrics import WORKER_METRICS

TERMINAL_RUN_STATUSES = frozenset(
    {RunStatus.completed, RunStatus.failed, RunStatus.canceled, RunStatus.budget_exceeded}
)


def run_duration_ms(row: RunRow, now: datetime) -> int:
    end = row.finished_at or now
    start = row.started_at or row.created_at
    return max(0, round((end - start).total_seconds() * 1000))


def missing_run(run_id: UUID) -> ApplicationError:
    return ApplicationError(f"run {run_id} does not exist", non_retryable=True)


class RunStatusActivities:
    def __init__(self, session_factory: SessionFactory, events: EventClient) -> None:
        self.session_factory = session_factory
        self.events = events

    @activity.defn(name=UPDATE_RUN_STATUS_ACTIVITY)
    async def update_run_status(self, request: UpdateRunStatusInput) -> UpdateRunStatusResult:
        async with self.session_factory() as session:
            row = await session.get(RunRow, request.run_id, with_for_update=True)
            if row is None:
                raise missing_run(request.run_id)
            previous = row.status
            if previous is request.status or previous in TERMINAL_RUN_STATUSES:
                return UpdateRunStatusResult()
            now = datetime.now(UTC)
            row.status = request.status
            if row.started_at is None and previous is RunStatus.queued:
                row.started_at = now
            final_counters: RunCounters | None = None
            if request.status in TERMINAL_RUN_STATUSES:
                row.finished_at = now
                final_counters = await read_run_counters(session, request.run_id)
                row.counters = event_payload(final_counters)
            spent_usd = float(row.spent_usd)
            duration_ms = run_duration_ms(row, now)
            kind = row.kind
            await session.commit()
        if previous is RunStatus.queued:
            WORKER_METRICS.count_run_started(kind)
        if final_counters is not None:
            WORKER_METRICS.count_run_finished(request.status)
        events = [
            build_event(
                request.run_id,
                "run.status_changed",
                RunStatusChangedPayload(
                    status=request.status, previous=previous, reason=request.reason
                ),
                f"status:{request.status.value}",
            )
        ]
        if final_counters is not None:
            events.append(
                build_event(
                    request.run_id,
                    "run.finished",
                    RunFinishedPayload(
                        status=request.status,
                        counters=final_counters,
                        spent_usd=spent_usd,
                        duration_ms=duration_ms,
                    ),
                    "finished",
                )
            )
            events.append(dashboard_invalidate_event())
        await self.events.deliver(events)
        return UpdateRunStatusResult()

    @activity.defn(name=FINALIZE_RUN_ACTIVITY)
    async def finalize_run(self, request: FinalizeRunInput) -> FinalizeRunResult:
        async with self.session_factory() as session:
            row = await session.get(RunRow, request.run_id, with_for_update=True)
            if row is None:
                raise missing_run(request.run_id)
            counters = await read_run_counters(session, request.run_id)
            row.counters = event_payload(counters)
            verdicts = await record_cell_verdicts_with_changes(session, request.run_id)
            await freeze_run_stats(session, request.run_id)
            result = FinalizeRunResult(
                counters=counters,
                spent_usd=float(row.spent_usd),
                duration_ms=run_duration_ms(row, datetime.now(UTC)),
            )
            await session.commit()
        events = coverage_updated_events(verdicts.changes, CoverageUpdateReason.run)
        if events:
            await self.events.deliver(events)
        return result

    @activity.defn(name=PUBLISH_RUN_PROGRESS)
    async def publish_run_progress(
        self, request: PublishRunProgressInput
    ) -> PublishRunProgressResult:
        async with self.session_factory() as session:
            row = await session.get(RunRow, request.run_id, with_for_update=True)
            if row is None:
                raise missing_run(request.run_id)
            counters = await read_run_counters(session, request.run_id)
            if row.status not in TERMINAL_RUN_STATUSES:
                row.counters = event_payload(counters)
            spend = await read_run_spend(session, request.run_id)
            await session.commit()
        budget = request.budget.model_copy(update={"spent_usd": float(spend.spent_usd)})
        await self.events.deliver(
            [
                build_event(
                    request.run_id, "run.progress", counters, f"progress:{request.sequence}"
                ),
                build_event(request.run_id, "budget.updated", budget, f"budget:{request.sequence}"),
            ]
        )
        return PublishRunProgressResult(
            counters=counters, spent_usd=float(spend.spent_usd), blocked_calls=spend.blocked_calls
        )
