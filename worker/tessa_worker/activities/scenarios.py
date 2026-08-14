import contextlib
from collections import defaultdict
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import CoverageCellRow, PlanRow, RunRow, RunScenarioRow, ScenarioRow
from tessa_api.db.session import SessionFactory
from tessa_api.errors import ApiError
from tessa_api.ids import new_id
from tessa_api.schemas.common import AttemptTally
from tessa_api.schemas.enums import (
    RunScenarioStatus,
    ScenarioOrigin,
    ScenarioStatus,
    ScheduleTier,
    SkipReason,
)
from tessa_api.schemas.scenarios import ScenarioValidation
from tessa_api.schemas.streams import (
    IngestEvent,
    ScenarioFinishedPayload,
    ScenarioQueuedPayload,
)
from tessa_api.schemas.temporal import (
    CREATE_RUN_SCENARIOS_ACTIVITY,
    EXPAND_CELLS_ACTIVITY,
    GENERATE_SMOKE_SCENARIO_ACTIVITY,
    VALIDATE_SCENARIO_ACTIVITY,
    CreateRunScenariosInput,
    CreateRunScenariosResult,
    ExpandCellsInput,
    ExpandCellsResult,
    GenerateSmokeScenarioInput,
    ValidateScenarioInput,
)
from tessa_api.services.plans import cell_key, expand_plan_cells, plan_cells_with_skips
from tessa_api.services.scenario_library import is_synthetic, validate_stored_scenario
from tessa_api.services.smoke_generator import generate_smoke_scenarios
from tessa_api.services.storage import BundleStore
from tessa_worker.activities.run_models import GenerateSmokeScenarioOutcome
from tessa_worker.event_client import EventClient, build_event
from tessa_worker.verdicts import skipped_verdict

CellKey = tuple[str, str, str]
RUNNABLE_SCENARIO_STATUSES = (
    ScenarioStatus.accepted,
    ScenarioStatus.quarantined,
    ScenarioStatus.invalid,
)
SMOKE_ORIGINS = frozenset({ScenarioOrigin.bundle_example})
SKIP_EXPLANATIONS: Mapping[SkipReason, str] = {
    SkipReason.adapter_unsupported: "the interface kind has no adapter yet",
    SkipReason.env_missing: "a variable the cell needs has no value in the target environment",
    SkipReason.role_unavailable: "the credential variable of the role has no value",
    SkipReason.hook_missing: "the feature needs a test hook the bundle does not offer",
    SkipReason.production_blocked: "the run is read-only and the feature writes data",
    SkipReason.quarantined: "the scenario is quarantined",
    SkipReason.precondition_failed: "the scenario is not valid",
}


def is_commit_tier(run: RunRow) -> bool:
    return run.config_snapshot.get("schedule_tier") == ScheduleTier.commit.value


def subset_scenario_ids(run: RunRow) -> frozenset[UUID] | None:
    raw = run.config_snapshot.get("scenario_ids")
    if not isinstance(raw, list):
        return None
    return frozenset(UUID(str(item)) for item in raw)


@dataclass(frozen=True, slots=True)
class PlannedRunScenario:
    scenario: ScenarioRow
    cell: CoverageCellRow
    skip_reason: SkipReason | None
    explanation: str | None


@contextlib.contextmanager
def api_errors_as_application_errors() -> Iterator[None]:
    try:
        yield
    except ApiError as error:
        raise ApplicationError(error.message, type=error.code, non_retryable=True) from error


def scenario_cell_key(scenario: ScenarioRow) -> CellKey:
    return (
        scenario.feature_id or "",
        str(scenario.parsed.get("role", "")),
        str(scenario.parsed.get("interface_id", "")),
    )


def invalid_explanation(scenario: ScenarioRow) -> str:
    errors = scenario.validation.get("errors") or []
    first = errors[0].get("message") if errors and isinstance(errors[0], dict) else None
    base = SKIP_EXPLANATIONS[SkipReason.precondition_failed]
    return f"{base}: {first}" if first else base


def decide_scenario(
    scenario: ScenarioRow, cell_skip: SkipReason | None
) -> tuple[SkipReason | None, str | None] | None:
    if scenario.status is ScenarioStatus.accepted:
        if cell_skip is None:
            return None, None
        return cell_skip, SKIP_EXPLANATIONS[cell_skip]
    if scenario.status is ScenarioStatus.quarantined:
        return SkipReason.quarantined, SKIP_EXPLANATIONS[SkipReason.quarantined]
    if scenario.status is ScenarioStatus.invalid:
        return SkipReason.precondition_failed, invalid_explanation(scenario)
    return None


def plan_run_scenarios(
    cells: Sequence[CoverageCellRow],
    scenarios: Sequence[ScenarioRow],
    cell_skips: Mapping[CellKey, SkipReason],
) -> list[PlannedRunScenario]:
    by_cell: dict[CellKey, list[ScenarioRow]] = defaultdict(list)
    for scenario in scenarios:
        by_cell[scenario_cell_key(scenario)].append(scenario)
    planned: list[PlannedRunScenario] = []
    for cell in cells:
        key = cell_key(cell)
        for scenario in by_cell.get(key, []):
            decision = decide_scenario(scenario, cell_skips.get(key))
            if decision is None:
                continue
            planned.append(PlannedRunScenario(scenario, cell, decision[0], decision[1]))
    return planned


def run_scenario_values(
    run_id: UUID, planned: PlannedRunScenario, attempts_total: int, now: datetime
) -> dict[str, Any]:
    skipped = planned.skip_reason is not None
    status = RunScenarioStatus.skipped if skipped else RunScenarioStatus.queued
    verdict = (
        skipped_verdict(planned.skip_reason, planned.explanation).model_dump(mode="json")
        if planned.skip_reason is not None
        else None
    )
    return {
        "id": new_id(),
        "run_id": run_id,
        "scenario_id": planned.scenario.id,
        "scenario_version": planned.scenario.version,
        "role": planned.cell.role,
        "interface_id": planned.cell.interface_id,
        "attempts_total": attempts_total,
        "status": status,
        "verdict": verdict,
        "skip_reason": planned.skip_reason,
        "attempts": [
            {"attempt": attempt, "status": status.value, "verdict": None}
            for attempt in range(attempts_total)
        ],
        "finished_at": now if skipped else None,
    }


def queued_event(
    run_id: UUID, row_id: UUID, planned: PlannedRunScenario, attempts: int
) -> IngestEvent:
    return build_event(
        run_id,
        "scenario.queued",
        ScenarioQueuedPayload(
            run_scenario_id=row_id,
            scenario_id=planned.scenario.id,
            title=planned.scenario.title,
            role=planned.cell.role,
            interface_id=planned.cell.interface_id,
            attempts_total=attempts,
        ),
        f"scenario.queued:{row_id}",
    )


def skipped_event(
    run_id: UUID,
    row_id: UUID,
    planned: PlannedRunScenario,
    reason: SkipReason,
    attempts: int,
) -> IngestEvent:
    return build_event(
        run_id,
        "scenario.finished",
        ScenarioFinishedPayload(
            run_scenario_id=row_id,
            status=RunScenarioStatus.skipped,
            verdict=skipped_verdict(reason, planned.explanation),
            attempts=AttemptTally(passed=0, failed=0, total=attempts),
            duration_ms=0,
        ),
        f"scenario.finished:{row_id}",
    )


class ScenarioPlanningActivities:
    def __init__(
        self, session_factory: SessionFactory, bundles: BundleStore, events: EventClient
    ) -> None:
        self.session_factory = session_factory
        self.bundles = bundles
        self.events = events

    @activity.defn(name=EXPAND_CELLS_ACTIVITY)
    async def expand_cells(self, request: ExpandCellsInput) -> ExpandCellsResult:
        async with self.session_factory() as session:
            with api_errors_as_application_errors():
                cell_ids = await expand_plan_cells(session, request.plan_id)
            await session.commit()
        return ExpandCellsResult(cell_ids=cell_ids)

    @activity.defn(name=GENERATE_SMOKE_SCENARIO_ACTIVITY)
    async def generate_smoke_scenario(
        self, request: GenerateSmokeScenarioInput
    ) -> GenerateSmokeScenarioOutcome:
        async with self.session_factory() as session:
            with api_errors_as_application_errors():
                generation = await generate_smoke_scenarios(session, self.bundles, request.cell_id)
            await session.commit()
        return GenerateSmokeScenarioOutcome(
            scenario_ids=list(generation.scenario_ids),
            created=generation.created,
            reused=generation.reused,
        )

    @activity.defn(name=VALIDATE_SCENARIO_ACTIVITY)
    async def validate_scenario(self, request: ValidateScenarioInput) -> ScenarioValidation:
        async with self.session_factory() as session:
            with api_errors_as_application_errors():
                validation = await validate_stored_scenario(session, request.scenario_id)
            await session.commit()
        return validation

    @activity.defn(name=CREATE_RUN_SCENARIOS_ACTIVITY)
    async def create_run_scenarios(
        self, request: CreateRunScenariosInput
    ) -> CreateRunScenariosResult:
        async with self.session_factory() as session:
            run = await session.get(RunRow, request.run_id, with_for_update=True)
            if run is None or run.plan_id is None:
                raise ApplicationError(
                    f"run {request.run_id} does not exist or has no plan", non_retryable=True
                )
            plan = await session.get(PlanRow, run.plan_id)
            if plan is None:
                raise ApplicationError(f"plan {run.plan_id} does not exist", non_retryable=True)
            with api_errors_as_application_errors():
                expansion = await plan_cells_with_skips(session, plan.id, run.read_only)
            cell_skips = {
                cell_key(cell): cell.skip_reason
                for cell in expansion.cells
                if cell.skip_reason is not None
            }
            cells = list(
                await session.scalars(
                    select(CoverageCellRow)
                    .where(CoverageCellRow.plan_id == plan.id)
                    .order_by(
                        CoverageCellRow.feature_id,
                        CoverageCellRow.role,
                        CoverageCellRow.interface_id,
                    )
                )
            )
            scenarios = list(
                await session.scalars(
                    select(ScenarioRow)
                    .where(
                        ScenarioRow.target_id == plan.target_id,
                        ScenarioRow.feature_id.in_({cell.feature_id for cell in cells}),
                        ScenarioRow.status.in_(RUNNABLE_SCENARIO_STATUSES),
                    )
                    .order_by(ScenarioRow.created_at, ScenarioRow.id)
                )
            )
            candidates = [scenario for scenario in scenarios if not is_synthetic(scenario)]
            if is_commit_tier(run):
                candidates = [
                    scenario for scenario in candidates if scenario.origin in SMOKE_ORIGINS
                ]
            subset = subset_scenario_ids(run)
            if subset is not None:
                candidates = [scenario for scenario in candidates if scenario.id in subset]
            planned = plan_run_scenarios(cells, candidates, cell_skips)
            now = datetime.now(UTC)
            values = [run_scenario_values(run.id, item, plan.k, now) for item in planned]
            by_identity = {
                (item.scenario.id, item.cell.role, item.cell.interface_id): item for item in planned
            }
            inserted: list[tuple[UUID, PlannedRunScenario]] = []
            if values:
                result = await session.execute(
                    insert(RunScenarioRow)
                    .values(values)
                    .on_conflict_do_nothing(
                        index_elements=[
                            RunScenarioRow.run_id,
                            RunScenarioRow.scenario_id,
                            RunScenarioRow.role,
                            RunScenarioRow.interface_id,
                        ]
                    )
                    .returning(
                        RunScenarioRow.id,
                        RunScenarioRow.scenario_id,
                        RunScenarioRow.role,
                        RunScenarioRow.interface_id,
                    )
                )
                inserted = [
                    (row_id, by_identity[(scenario_id, role, interface_id)])
                    for row_id, scenario_id, role, interface_id in result
                ]
            run.config_snapshot = {
                **run.config_snapshot,
                "scenario_versions": {
                    str(item.scenario.id): item.scenario.version for item in planned
                },
            }
            row_ids = list(
                await session.scalars(
                    select(RunScenarioRow.id)
                    .where(RunScenarioRow.run_id == run.id)
                    .order_by(RunScenarioRow.created_at, RunScenarioRow.id)
                )
            )
            await session.commit()
        events: list[IngestEvent] = []
        for row_id, item in sorted(inserted, key=lambda entry: entry[0]):
            events.append(queued_event(request.run_id, row_id, item, plan.k))
            if item.skip_reason is not None:
                events.append(skipped_event(request.run_id, row_id, item, item.skip_reason, plan.k))
        await self.events.deliver_all(events)
        return CreateRunScenariosResult(run_scenario_ids=row_ids)
