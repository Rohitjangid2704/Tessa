import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, MutantRow, MutationRunRow, PlanRow, RunRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.db.session import SessionFactory
from tessa_api.errors import ApiError, not_found
from tessa_api.ids import new_id
from tessa_api.schemas.common import Budget, ErrorDetail, RunHandle
from tessa_api.schemas.enums import MutantStatus, RunKind, RunStatus, RunTrigger
from tessa_api.schemas.mutation import (
    MutationOutcomeItem,
    MutationRun,
    MutationRunCreate,
    MutationRunPage,
)
from tessa_api.schemas.plans import PlanSelection
from tessa_api.schemas.temporal import (
    MUTATION_RUN_WORKFLOW,
    MutationRunInput,
    mutation_workflow_id,
)
from tessa_api.services.hello import zero_run_counters
from tessa_api.services.mutants import get_mutant_row, has_active_mutation_run
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.plans import (
    evaluate_selection,
    get_plan_row,
    materialize_cells,
    plan_empty_error,
)
from tessa_api.services.production_url import is_plain_http_address, matches_production_pattern
from tessa_api.services.run_guard import (
    assess_production,
    enforce_forced_tier,
    ensure_environment_ready,
)
from tessa_api.services.run_service import (
    bundle_of_saved_plan,
    initial_config_snapshot,
    record_start_failure,
    run_created_event,
)
from tessa_api.services.targets import get_active_target
from tessa_api.services.vault import Vault
from tessa_api.settings import Settings
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import append_events
from tessa_api.temporal_client import TemporalGateway

MUTATION_RUN_SORT_COLUMNS: dict[str, SortableColumn] = {
    "started_at": sortable(MutationRunRow.started_at, datetime),
}
MUTATION_RUN_ID_COLUMN = sortable(MutationRunRow.id, uuid.UUID)


@dataclass(frozen=True, slots=True)
class PreparedMutationRun:
    run: RunRow
    mutation_run: MutationRunRow
    mutant: MutantRow
    address: str

    @property
    def handle(self) -> RunHandle:
        return RunHandle(
            run_id=self.run.id,
            workflow_id=self.run.workflow_id,
            kind=self.run.kind,
            status=self.run.status,
            created_at=self.run.created_at,
        )


def to_mutation_run(row: MutationRunRow, run: RunRow) -> MutationRun:
    return MutationRun(
        id=row.id,
        run_id=row.run_id,
        mutant_id=row.mutant_id,
        plan_id=row.plan_id,
        baseline_run_id=row.baseline_run_id,
        status=run.status,
        outcomes=[MutationOutcomeItem.model_validate(item) for item in row.outcomes],
        power=None if row.power is None else float(row.power),
        started_at=row.started_at,
        finished_at=row.finished_at or run.finished_at,
    )


async def list_mutation_runs(
    session: AsyncSession,
    query: PageQuery,
    target_id: uuid.UUID | None,
    mutant_id: uuid.UUID | None,
) -> MutationRunPage:
    statement = select(MutationRunRow)
    if target_id is not None:
        statement = statement.where(
            MutationRunRow.run_id.in_(select(RunRow.id).where(RunRow.target_id == target_id))
        )
    if mutant_id is not None:
        statement = statement.where(MutationRunRow.mutant_id == mutant_id)
    page = await paginate(
        session, statement, MUTATION_RUN_SORT_COLUMNS, MUTATION_RUN_ID_COLUMN, query
    )
    records = [row[0] for row in page.rows]
    runs = await load_runs(session, [record.run_id for record in records])
    return MutationRunPage(
        items=[to_mutation_run(record, runs[record.run_id]) for record in records],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def load_runs(session: AsyncSession, run_ids: list[uuid.UUID]) -> dict[uuid.UUID, RunRow]:
    if not run_ids:
        return {}
    rows = await session.scalars(select(RunRow).where(RunRow.id.in_(run_ids)))
    return {row.id: row for row in rows}


async def read_mutation_run(session: AsyncSession, mutation_run_id: uuid.UUID) -> MutationRun:
    row = await session.get(MutationRunRow, mutation_run_id)
    if row is None:
        raise not_found("Mutation run not found")
    run = await session.get(RunRow, row.run_id)
    if run is None:
        raise not_found("Mutation run not found")
    return to_mutation_run(row, run)


def mutation_blocked_error(target_name: str) -> ApiError:
    return ApiError(
        409,
        "production_blocked",
        f"{target_name} is a production target; mutation runs are always blocked there",
        [
            ErrorDetail(
                loc=["target", "tier"],
                code="production_blocked",
                message="A mutation run is never allowed on a production target",
            )
        ],
    )


def production_address_error(loc: list[str | int]) -> ApiError:
    return ApiError(
        409,
        "production_blocked",
        "The address of the mutant matches a production URL pattern; a mutant never runs there",
        [
            ErrorDetail(
                loc=loc,
                code="production_blocked",
                message="Deploy the mutant to a QA address and use that one",
            )
        ],
    )


def mismatch_error(field_name: str, message: str) -> ApiError:
    return ApiError(
        422,
        "validation_failed",
        "Request validation failed",
        [ErrorDetail(loc=["body", field_name], code=f"{field_name}_mismatch", message=message)],
    )


def not_deployed_error(mutant: MutantRow) -> ApiError:
    return ApiError(
        409,
        "conflict",
        f"The mutant {mutant.name!r} is {mutant.status.value}; only a deployed mutant can run",
        [
            ErrorDetail(
                loc=["body", "mutant_id"],
                code="mutant_not_deployed",
                message="Mark the mutant deployed, with the address where its branch runs, first",
            )
        ],
    )


def address_missing_error() -> ApiError:
    return ApiError(
        422,
        "validation_failed",
        "Request validation failed",
        [
            ErrorDetail(
                loc=["body", "base_url_override"],
                code="base_url_required",
                message="The mutant has no base URL; send base_url_override",
            )
        ],
    )


def address_invalid_error(loc: list[str | int]) -> ApiError:
    return ApiError(
        422,
        "validation_failed",
        "Request validation failed",
        [
            ErrorDetail(
                loc=loc,
                code="base_url_invalid",
                message="The address must be an http or https address without credentials, "
                "query or fragment",
            )
        ],
    )


def run_active_error(mutant: MutantRow) -> ApiError:
    return ApiError(
        409,
        "conflict",
        "A mutation run of this mutant is in progress; wait for it to finish or cancel it",
        [
            ErrorDetail(
                loc=["body", "mutant_id"],
                code="mutation_run_active",
                message=f"{mutant.name!r} has a mutation run that has not finished",
            )
        ],
    )


def effective_address(body: MutationRunCreate, mutant: MutantRow) -> tuple[str, list[str | int]]:
    if body.base_url_override is not None:
        return body.base_url_override, ["body", "base_url_override"]
    if mutant.base_url is not None:
        return mutant.base_url, ["mutant", "base_url"]
    raise address_missing_error()


def ensure_address_usable(settings: Settings, address: str, loc: list[str | int]) -> None:
    if not is_plain_http_address(address):
        raise address_invalid_error(loc)
    if matches_production_pattern(settings, address):
        raise production_address_error(loc)


async def load_mutation_subjects(
    session: AsyncSession, target: TargetRow, body: MutationRunCreate
) -> tuple[MutantRow, PlanRow]:
    mutant = await get_mutant_row(session, body.mutant_id)
    if mutant.target_id != target.id:
        raise mismatch_error("mutant_id", "The mutant belongs to another target")
    plan = await get_plan_row(session, body.plan_id)
    if plan.target_id != target.id:
        raise mismatch_error("plan_id", "The plan belongs to another target")
    return mutant, plan


def new_mutation_run_row(
    target: TargetRow,
    plan: PlanRow,
    bundle: BundleRow,
    address: str,
    user_id: uuid.UUID,
    created_at: datetime,
) -> RunRow:
    run_id = new_id()
    snapshot = initial_config_snapshot(bundle).model_copy(update={"base_url_override": address})
    return RunRow(
        id=run_id,
        kind=RunKind.mutation,
        target_id=target.id,
        plan_id=plan.id,
        bundle_id=bundle.id,
        status=RunStatus.queued,
        trigger=RunTrigger.manual,
        read_only=False,
        config_snapshot=snapshot.model_dump(mode="json"),
        budget=Budget.model_validate(plan.budget).model_dump(mode="json"),
        counters=zero_run_counters().model_dump(mode="json"),
        workflow_id=mutation_workflow_id(run_id),
        created_by=user_id,
        created_at=created_at,
    )


def new_mutation_run_record(
    run: RunRow, mutant: MutantRow, plan: PlanRow, started_at: datetime
) -> MutationRunRow:
    return MutationRunRow(
        id=new_id(),
        run_id=run.id,
        mutant_id=mutant.id,
        plan_id=plan.id,
        baseline_run_id=None,
        outcomes=[],
        power=None,
        started_at=started_at,
        finished_at=None,
    )


async def prepare_mutation_run(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    user_id: uuid.UUID,
    body: MutationRunCreate,
) -> PreparedMutationRun:
    target = await get_active_target(session, body.target_id)
    assessment = await assess_production(session, settings, vault, target)
    await enforce_forced_tier(session, target, assessment)
    if assessment.production:
        raise mutation_blocked_error(target.name)
    mutant, plan = await load_mutation_subjects(session, target, body)
    if mutant.status is not MutantStatus.deployed:
        raise not_deployed_error(mutant)
    address, location = effective_address(body, mutant)
    ensure_address_usable(settings, address, location)
    if await has_active_mutation_run(session, mutant.id):
        raise run_active_error(mutant)
    bundle = await bundle_of_saved_plan(session, plan, target)
    evaluation = await evaluate_selection(
        session, settings, vault, target, bundle, PlanSelection.model_validate(plan.selection)
    )
    if not evaluation.expansion.cells:
        raise plan_empty_error(["body"])
    ensure_environment_ready(evaluation.expansion.cells, evaluation.context)
    if not plan.is_coverage_baseline:
        plan.bundle_id = bundle.id
    await materialize_cells(session, plan.id, evaluation.expansion.cells)
    created_at = datetime.now(UTC)
    run = new_mutation_run_row(target, plan, bundle, address, user_id, created_at)
    session.add(run)
    await session.flush()
    record = new_mutation_run_record(run, mutant, plan, created_at)
    session.add(record)
    await session.commit()
    return PreparedMutationRun(run=run, mutation_run=record, mutant=mutant, address=address)


async def start_mutation_run(
    session: AsyncSession,
    session_factory: SessionFactory,
    hub: Hub,
    temporal: TemporalGateway,
    settings: Settings,
    vault: Vault,
    user_id: uuid.UUID,
    body: MutationRunCreate,
) -> RunHandle:
    prepared = await prepare_mutation_run(session, settings, vault, user_id, body)
    run = prepared.run
    try:
        await append_events(session_factory, hub, [run_created_event(run)])
        await temporal.start_workflow(
            MUTATION_RUN_WORKFLOW,
            MutationRunInput(
                run_id=run.id,
                mutation_run_id=prepared.mutation_run.id,
                mutant_id=prepared.mutant.id,
                plan_id=prepared.mutation_run.plan_id,
                base_url_override=body.base_url_override,
            ),
            run.workflow_id,
        )
    except Exception:
        await record_start_failure(session_factory, hub, run)
        raise
    return prepared.handle
