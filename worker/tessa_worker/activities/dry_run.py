from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity

from tessa_api.db.models import RunRow, RunScenarioRow, ScenarioRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.common import Budget, Verdict
from tessa_api.schemas.enums import (
    CoverageUpdateReason,
    RunKind,
    RunScenarioStatus,
    ScenarioStatus,
    VerdictStatus,
)
from tessa_api.schemas.scenarios import ScenarioDryRun, ScenarioIssue
from tessa_api.schemas.streams import IngestEvent, ScenarioQueuedPayload
from tessa_api.schemas.temporal import (
    DRY_RUN_SCENARIO_ACTIVITY,
    DryRunScenarioInput,
    DryRunScenarioResult,
)
from tessa_api.services.scenario_lifecycle import (
    complete_dry_runs,
    lifecycle_events,
    provenance_row_for,
)
from tessa_api.services.settings_service import effective_settings
from tessa_worker.activities.dry_run_models import (
    LOAD_DRY_RUN_CONTEXT,
    PREPARE_DRY_RUN,
    SKIP_DRY_RUN,
    DryRunContext,
    DryRunErrorType,
    LoadDryRunContextInput,
    PreparedDryRun,
    PrepareDryRunInput,
    SkipDryRunInput,
    SkipDryRunResult,
    permanent_dry_run_error,
)
from tessa_worker.activities.run_context import scenario_timeout_seconds
from tessa_worker.event_client import EventClient, build_event
from tessa_worker.settings import WorkerSettings

DRY_RUN_FAILED_CODE = "dry_run_failed"
DRY_RUN_SKIPPED_CODE = "dry_run_skipped"
DRY_RUNNABLE_STATUSES = frozenset({ScenarioStatus.draft, ScenarioStatus.validating})
REASON_CHARS = 200


def warning(code: str, message: str) -> ScenarioIssue:
    return ScenarioIssue(code=code, pointer=None, line=None, column=None, message=message)


def attempt_verdicts(row: RunScenarioRow) -> list[Verdict]:
    entries = sorted(row.attempts, key=lambda entry: int(entry.get("attempt", 0)))
    return [Verdict.model_validate(entry["verdict"]) for entry in entries if entry.get("verdict")]


def dry_run_entries(rows: Sequence[RunScenarioRow]) -> list[ScenarioDryRun]:
    return [
        ScenarioDryRun(run_id=row.run_id, run_scenario_id=row.id, verdict=verdict)
        for row in rows
        for verdict in attempt_verdicts(row)
    ]


def passed_every_repeat(rows: Sequence[RunScenarioRow]) -> bool:
    if not rows:
        return False
    for row in rows:
        verdicts = attempt_verdicts(row)
        if len(verdicts) < row.attempts_total:
            return False
        if any(verdict.status is not VerdictStatus.pass_ for verdict in verdicts):
            return False
    return True


def first_reason(entries: Sequence[ScenarioDryRun]) -> str | None:
    for entry in entries:
        if entry.verdict.status is not VerdictStatus.pass_ and entry.verdict.reason:
            return entry.verdict.reason[:REASON_CHARS]
    return None


def outcome_warning(
    rows: Sequence[RunScenarioRow], entries: Sequence[ScenarioDryRun]
) -> ScenarioIssue | None:
    if passed_every_repeat(rows):
        return None
    statuses = [entry.verdict.status for entry in entries]
    reason = first_reason(entries)
    suffix = f": {reason}" if reason else ""
    if not statuses:
        return warning(DRY_RUN_SKIPPED_CODE, "The dry runs did not execute")
    if all(status is VerdictStatus.skipped for status in statuses):
        return warning(DRY_RUN_SKIPPED_CODE, f"The dry runs were skipped{suffix}")
    listed = ", ".join(status.value for status in statuses)
    return warning(
        DRY_RUN_FAILED_CODE,
        f"The scenario did not pass every dry run ({listed}){suffix}; review it before accepting",
    )


class DryRunActivities:
    def __init__(
        self, settings: WorkerSettings, session_factory: SessionFactory, events: EventClient
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events

    @activity.defn(name=LOAD_DRY_RUN_CONTEXT)
    async def load_dry_run_context(self, request: LoadDryRunContextInput) -> DryRunContext:
        async with self.session_factory() as session:
            run = await session.get(RunRow, request.run_id)
            if run is None or run.kind is not RunKind.generate:
                raise permanent_dry_run_error(
                    DryRunErrorType.run_not_found,
                    f"run {request.run_id} does not exist or is not a dry-run run",
                )
            effective = await effective_settings(session, self.settings)
            return DryRunContext(
                dry_run_repeats=effective.dry_run_repeats,
                dry_run_concurrency=effective.run_max_concurrency,
                budget=Budget.model_validate(run.budget),
            )

    @activity.defn(name=PREPARE_DRY_RUN)
    async def prepare_dry_run(self, request: PrepareDryRunInput) -> PreparedDryRun:
        async with self.session_factory() as session:
            run = await session.get(RunRow, request.run_id, with_for_update=True)
            scenario = await session.get(ScenarioRow, request.scenario_id)
            if run is None or scenario is None:
                raise permanent_dry_run_error(
                    DryRunErrorType.scenario_not_found,
                    f"run {request.run_id} or scenario {request.scenario_id} does not exist",
                )
            timeout = scenario_timeout_seconds(
                scenario.parsed, self.settings.scenario_timeout_seconds
            )
            if scenario.status not in DRY_RUNNABLE_STATUSES:
                return PreparedDryRun(
                    outcome="ineligible",
                    run_scenario_id=None,
                    attempts=request.repeats,
                    timeout_seconds=timeout,
                    detail=f"the scenario is {scenario.status.value}, not waiting for its dry runs",
                )
            role = str(scenario.parsed.get("role", ""))
            interface_id = str(scenario.parsed.get("interface_id", ""))
            existing = await session.scalar(
                select(RunScenarioRow).where(
                    RunScenarioRow.run_id == request.run_id,
                    RunScenarioRow.scenario_id == request.scenario_id,
                    RunScenarioRow.role == role,
                    RunScenarioRow.interface_id == interface_id,
                )
            )
            created = existing is None
            row = (
                self.new_row(request, scenario, role, interface_id)
                if existing is None
                else existing
            )
            if created:
                session.add(row)
                run.config_snapshot = self.pinned_snapshot(run.config_snapshot, scenario)
                await session.flush()
            prepared = PreparedDryRun(
                outcome="ready",
                run_scenario_id=row.id,
                attempts=row.attempts_total,
                timeout_seconds=timeout,
                detail=None,
            )
            queued = self.queued_event(request.run_id, row, scenario) if created else None
            await session.commit()
        if queued is not None:
            await self.events.deliver([queued])
        return prepared

    @activity.defn(name=DRY_RUN_SCENARIO_ACTIVITY)
    async def dry_run_scenario(self, request: DryRunScenarioInput) -> DryRunScenarioResult:
        async with self.session_factory() as session:
            scenario = await session.get(ScenarioRow, request.scenario_id)
            if scenario is None:
                raise permanent_dry_run_error(
                    DryRunErrorType.scenario_not_found,
                    f"scenario {request.scenario_id} does not exist",
                )
            rows = list(
                await session.scalars(
                    select(RunScenarioRow)
                    .where(
                        RunScenarioRow.run_id == request.run_id,
                        RunScenarioRow.scenario_id == request.scenario_id,
                    )
                    .order_by(RunScenarioRow.created_at, RunScenarioRow.id)
                )
            )
            entries = dry_run_entries(rows)
            passed = passed_every_repeat(rows)
            recorded = (
                [] if await self.already_recorded(session, scenario, request.run_id) else entries
            )
            issue = outcome_warning(rows, entries)
            write = await complete_dry_runs(
                session, scenario.id, recorded, [] if issue is None else [issue]
            )
            events = lifecycle_events(write, CoverageUpdateReason.generated)
            run_scenario_ids = [row.id for row in rows]
            await session.commit()
        await self.events.deliver_all(events)
        return DryRunScenarioResult(passed_twice=passed, run_scenario_ids=run_scenario_ids)

    @activity.defn(name=SKIP_DRY_RUN)
    async def skip_dry_run(self, request: SkipDryRunInput) -> SkipDryRunResult:
        async with self.session_factory() as session:
            scenario = await session.get(ScenarioRow, request.scenario_id)
            if scenario is None:
                raise permanent_dry_run_error(
                    DryRunErrorType.scenario_not_found,
                    f"scenario {request.scenario_id} does not exist",
                )
            write = await complete_dry_runs(
                session, scenario.id, [], [warning(DRY_RUN_SKIPPED_CODE, request.reason)]
            )
            events = lifecycle_events(write, CoverageUpdateReason.generated)
            await session.commit()
        await self.events.deliver_all(events)
        return SkipDryRunResult(scenario_id=request.scenario_id)

    async def already_recorded(
        self, session: AsyncSession, scenario: ScenarioRow, run_id: UUID
    ) -> bool:
        provenance = await provenance_row_for(session, scenario)
        return any(entry.get("run_id") == str(run_id) for entry in provenance.dry_runs)

    def new_row(
        self, request: PrepareDryRunInput, scenario: ScenarioRow, role: str, interface_id: str
    ) -> RunScenarioRow:
        return RunScenarioRow(
            id=new_id(),
            run_id=request.run_id,
            scenario_id=scenario.id,
            scenario_version=scenario.version,
            role=role,
            interface_id=interface_id,
            attempts_total=request.repeats,
            status=RunScenarioStatus.queued,
            verdict=None,
            attempts=[
                {"attempt": attempt, "status": RunScenarioStatus.queued.value, "verdict": None}
                for attempt in range(request.repeats)
            ],
        )

    def pinned_snapshot(self, snapshot: dict[str, Any], scenario: ScenarioRow) -> dict[str, Any]:
        versions = dict(snapshot.get("scenario_versions") or {})
        versions[str(scenario.id)] = scenario.version
        return {**snapshot, "scenario_versions": versions}

    def queued_event(self, run_id: UUID, row: RunScenarioRow, scenario: ScenarioRow) -> IngestEvent:
        return build_event(
            run_id,
            "scenario.queued",
            ScenarioQueuedPayload(
                run_scenario_id=row.id,
                scenario_id=scenario.id,
                title=scenario.title,
                role=row.role,
                interface_id=row.interface_id,
                attempts_total=row.attempts_total,
            ),
            f"scenario.queued:{row.id}",
        )
