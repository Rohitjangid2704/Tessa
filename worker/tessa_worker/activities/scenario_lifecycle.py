from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import RunScenarioRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import AttemptTally, Verdict
from tessa_api.schemas.enums import RunScenarioStatus, VerdictStatus
from tessa_api.schemas.streams import (
    IngestEvent,
    ScenarioFinishedPayload,
    ScenarioStartedPayload,
    ScenarioVerdictPayload,
)
from tessa_api.services.grading_rules import MachineGrading
from tessa_api.services.run_counters import DONE_SCENARIO_STATUSES
from tessa_api.services.step_overlay import StepStanding, step_graded_event
from tessa_worker.activities.names import (
    BEGIN_SCENARIO_ATTEMPT,
    FINISH_RUN_SCENARIO,
    RECORD_SCENARIO_ATTEMPT,
    SKIP_RUN_SCENARIOS,
    SKIP_UNGRADED_STEPS,
)
from tessa_worker.activities.run_models import (
    BeginScenarioAttemptInput,
    FinishRunScenarioInput,
    RecordScenarioAttemptInput,
    SkipRunScenariosInput,
    SkipRunScenariosResult,
    SkipUngradedStepsInput,
    SkipUngradedStepsResult,
)
from tessa_worker.event_client import EventClient, build_event
from tessa_worker.verdicts import skipped_verdict

OPEN_ATTEMPT_STATUSES = frozenset({RunScenarioStatus.queued.value, RunScenarioStatus.running.value})


def attempt_entry(
    attempt: int, status: RunScenarioStatus, verdict: Verdict | None
) -> dict[str, Any]:
    return {
        "attempt": attempt,
        "status": status.value,
        "verdict": None if verdict is None else verdict.model_dump(mode="json"),
    }


def with_attempt(
    attempts: list[dict[str, Any]], attempt: int, entry: dict[str, Any]
) -> list[dict[str, Any]]:
    kept = [existing for existing in attempts if existing["attempt"] != attempt]
    return sorted([*kept, entry], key=lambda existing: existing["attempt"])


def close_open_attempts(
    attempts: list[dict[str, Any]], status: RunScenarioStatus
) -> list[dict[str, Any]]:
    return [
        {**entry, "status": status.value} if entry["status"] in OPEN_ATTEMPT_STATUSES else entry
        for entry in attempts
    ]


def tally_attempts(attempts: list[dict[str, Any]], total: int) -> AttemptTally:
    statuses = [
        entry["verdict"]["status"] for entry in attempts if entry.get("verdict") is not None
    ]
    return AttemptTally(
        passed=statuses.count(VerdictStatus.pass_.value),
        failed=statuses.count(VerdictStatus.fail.value),
        total=total,
    )


def duration_ms(row: RunScenarioRow, finished_at: datetime) -> int:
    if row.started_at is None:
        return 0
    return max(0, round((finished_at - row.started_at).total_seconds() * 1000))


async def locked_row(session: AsyncSession, run_scenario_id: UUID) -> RunScenarioRow:
    row = await session.get(RunScenarioRow, run_scenario_id, with_for_update=True)
    if row is None:
        raise ApplicationError(f"run scenario {run_scenario_id} does not exist", non_retryable=True)
    return row


def finished_event(row: RunScenarioRow, verdict: Verdict | None, duration: int) -> IngestEvent:
    return build_event(
        row.run_id,
        "scenario.finished",
        ScenarioFinishedPayload(
            run_scenario_id=row.id,
            status=row.status,
            verdict=verdict,
            attempts=tally_attempts(row.attempts, row.attempts_total),
            duration_ms=duration,
        ),
        f"scenario.finished:{row.id}",
    )


class ScenarioLifecycleActivities:
    def __init__(self, session_factory: SessionFactory, events: EventClient) -> None:
        self.session_factory = session_factory
        self.events = events

    @activity.defn(name=BEGIN_SCENARIO_ATTEMPT)
    async def begin_scenario_attempt(self, request: BeginScenarioAttemptInput) -> None:
        async with self.session_factory() as session:
            row = await locked_row(session, request.run_scenario_id)
            if row.status in DONE_SCENARIO_STATUSES:
                return
            row.status = RunScenarioStatus.running
            if row.started_at is None:
                row.started_at = datetime.now(UTC)
            row.attempts = with_attempt(
                row.attempts,
                request.attempt,
                attempt_entry(request.attempt, RunScenarioStatus.running, None),
            )
            run_id = row.run_id
            await session.commit()
        await self.events.deliver(
            [
                build_event(
                    run_id,
                    "scenario.started",
                    ScenarioStartedPayload(
                        run_scenario_id=request.run_scenario_id, attempt=request.attempt
                    ),
                    f"scenario.started:{request.run_scenario_id}:{request.attempt}",
                )
            ]
        )

    @activity.defn(name=RECORD_SCENARIO_ATTEMPT)
    async def record_scenario_attempt(self, request: RecordScenarioAttemptInput) -> None:
        async with self.session_factory() as session:
            row = await locked_row(session, request.run_scenario_id)
            row.attempts = with_attempt(
                row.attempts,
                request.attempt,
                attempt_entry(request.attempt, request.status, request.verdict),
            )
            run_id = row.run_id
            await session.commit()
        if request.verdict is None:
            return
        await self.events.deliver(
            [
                build_event(
                    run_id,
                    "scenario.verdict",
                    ScenarioVerdictPayload(
                        run_scenario_id=request.run_scenario_id,
                        attempt=request.attempt,
                        verdict=request.verdict,
                    ),
                    f"scenario.verdict:{request.run_scenario_id}:{request.attempt}",
                )
            ]
        )

    @activity.defn(name=FINISH_RUN_SCENARIO)
    async def finish_run_scenario(self, request: FinishRunScenarioInput) -> None:
        if request.status not in DONE_SCENARIO_STATUSES:
            raise ApplicationError(
                f"{request.status.value} is not a final run scenario status", non_retryable=True
            )
        async with self.session_factory() as session:
            row = await locked_row(session, request.run_scenario_id)
            if row.status in DONE_SCENARIO_STATUSES:
                return
            finished_at = datetime.now(UTC)
            row.status = request.status
            row.verdict = (
                None if request.verdict is None else request.verdict.model_dump(mode="json")
            )
            if request.status is RunScenarioStatus.skipped and request.verdict is not None:
                row.skip_reason = request.verdict.skip_reason
            if request.status in {RunScenarioStatus.canceled, RunScenarioStatus.skipped}:
                row.attempts = close_open_attempts(row.attempts, request.status)
            row.finished_at = finished_at
            event = finished_event(row, request.verdict, duration_ms(row, finished_at))
            await session.commit()
        await self.events.deliver([event])

    @activity.defn(name=SKIP_RUN_SCENARIOS)
    async def skip_run_scenarios(self, request: SkipRunScenariosInput) -> SkipRunScenariosResult:
        verdict = skipped_verdict(request.reason)
        events: list[IngestEvent] = []
        skipped_ids: list[UUID] = []
        async with self.session_factory() as session:
            rows = await session.scalars(
                select(RunScenarioRow)
                .where(
                    RunScenarioRow.run_id == request.run_id,
                    RunScenarioRow.status == RunScenarioStatus.queued,
                )
                .order_by(RunScenarioRow.created_at, RunScenarioRow.id)
                .with_for_update()
            )
            finished_at = datetime.now(UTC)
            for row in rows:
                row.status = RunScenarioStatus.skipped
                row.skip_reason = request.reason
                row.verdict = verdict.model_dump(mode="json")
                row.attempts = close_open_attempts(row.attempts, RunScenarioStatus.skipped)
                row.finished_at = finished_at
                skipped_ids.append(row.id)
                events.append(finished_event(row, verdict, 0))
            await session.commit()
        await self.events.deliver_all(events)
        return SkipRunScenariosResult(run_scenario_ids=skipped_ids)

    @activity.defn(name=SKIP_UNGRADED_STEPS)
    async def skip_ungraded_steps(self, request: SkipUngradedStepsInput) -> SkipUngradedStepsResult:
        verdict = skipped_verdict(request.reason)
        grading = MachineGrading(verdict=verdict, escalated_to=None, review_reasons=[])
        standing = StepStanding(verdict, None)
        events: list[IngestEvent] = []
        skipped_ids: list[UUID] = []
        async with self.session_factory() as session:
            rows = await session.scalars(
                select(StepRow)
                .where(StepRow.run_id == request.run_id, StepRow.verdict.is_(None))
                .order_by(StepRow.started_at, StepRow.id)
                .with_for_update()
            )
            for step in rows:
                step.verdict = verdict.model_dump(mode="json")
                step.machine_grading = grading.model_dump(mode="json")
                skipped_ids.append(step.id)
                graded = step_graded_event(step, standing, request.reason.value)
                if graded is not None:
                    events.append(graded)
            await session.commit()
        await self.events.deliver_all(events)
        return SkipUngradedStepsResult(step_ids=skipped_ids)
