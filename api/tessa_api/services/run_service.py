import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, PlanRow, RunRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.db.session import SessionFactory
from tessa_api.errors import ApiError
from tessa_api.ids import new_id
from tessa_api.schemas.common import Budget, RunHandle
from tessa_api.schemas.enums import RunKind, RunStatus
from tessa_api.schemas.plans import PlanSelection
from tessa_api.schemas.runs import RunConfigSnapshot, RunCreate
from tessa_api.schemas.streams import IngestEvent, RunCreatedPayload, RunStatusChangedPayload
from tessa_api.schemas.temporal import (
    CANCEL_SIGNAL,
    EXECUTE_RUN_WORKFLOW,
    ExecuteRunInput,
    execute_run_workflow_id,
)
from tessa_api.services.hello import run_finished_payload, zero_run_counters
from tessa_api.services.plans import (
    PlanEvaluation,
    evaluate_selection,
    get_plan_row,
    insert_plan,
    latest_valid_bundle,
    materialize_cells,
    plan_empty_error,
    resolve_plan_bundle,
    validate_selection,
)
from tessa_api.services.run_guard import (
    enforce_forced_tier,
    ensure_bundle_usable,
    ensure_environment_ready,
    ensure_production_allowed,
    ensure_reset_seed_allowed,
)
from tessa_api.services.run_origin import MANUAL_ORIGIN, RunOrigin
from tessa_api.services.run_views import TERMINAL_RUN_STATUSES, get_run_row
from tessa_api.services.scenario_subset import (
    SubsetScenario,
    build_subset_plan,
    restrict_to_subset,
)
from tessa_api.services.settings_service import effective_settings
from tessa_api.services.targets import get_active_target
from tessa_api.services.vault import Vault
from tessa_api.settings import Settings
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import append_events
from tessa_api.temporal_client import TemporalGateway, WorkflowNotRunningError

logger = logging.getLogger("tessa_api.runs")

RUN_CREATED_DEDUPE_KEY = "created"
START_FAILED_STATUS_DEDUPE_KEY = "start_failed"
START_FAILED_FINISHED_DEDUPE_KEY = "start_failed_finished"
START_FAILED_REASON = "The workflow could not be started"
BODY_LOCATION = ("body",)
INLINE_PLAN_LOCATION = ("body", "plan")
SUBSET_LOCATION = ("body", "scenario_ids")


@dataclass(frozen=True, slots=True)
class PreparedRun:
    run: RunRow
    max_concurrency: int
    reset_seed: bool

    @property
    def handle(self) -> RunHandle:
        return RunHandle(
            run_id=self.run.id,
            workflow_id=self.run.workflow_id,
            kind=self.run.kind,
            status=self.run.status,
            created_at=self.run.created_at,
        )


def initial_config_snapshot(
    bundle: BundleRow, scenario_ids: Sequence[uuid.UUID] | None = None
) -> RunConfigSnapshot:
    return RunConfigSnapshot(
        bundle_id=bundle.id,
        bundle_version=bundle.version,
        bundle_hash=bundle.hash,
        seed_hash=None,
        clock=None,
        models=None,
        probe_bank_version=None,
        prompt_template_versions={},
        scenario_versions={},
        scenario_ids=list(scenario_ids) if scenario_ids is not None else None,
        bundle_commit=bundle.commit_sha,
    )


def resolve_concurrency(requested: int | None, settings: Settings) -> int:
    return min(requested or settings.run_max_concurrency, settings.run_max_concurrency)


def new_run_row(
    run_id: uuid.UUID,
    plan: PlanRow,
    evaluation: PlanEvaluation,
    budget: Budget,
    user_id: uuid.UUID,
    created_at: datetime,
    origin: RunOrigin = MANUAL_ORIGIN,
    scenario_ids: Sequence[uuid.UUID] | None = None,
) -> RunRow:
    snapshot = initial_config_snapshot(evaluation.bundle, scenario_ids)
    return RunRow(
        id=run_id,
        kind=RunKind.suite,
        target_id=evaluation.target.id,
        plan_id=plan.id,
        bundle_id=evaluation.bundle.id,
        status=RunStatus.queued,
        trigger=origin.trigger,
        read_only=evaluation.assessment.production,
        config_snapshot=origin.snapshot_for(snapshot).model_dump(mode="json"),
        budget=budget.model_dump(mode="json"),
        counters=zero_run_counters().model_dump(mode="json"),
        workflow_id=execute_run_workflow_id(run_id),
        created_by=user_id,
        created_at=created_at,
    )


@dataclass(frozen=True, slots=True)
class RunPlanSource:
    saved_plan: PlanRow | None
    selection: PlanSelection
    bundle: BundleRow
    target: TargetRow
    inline_name: str | None
    plan_location: tuple[str, ...]
    include_api_fuzz: bool
    subset: tuple[SubsetScenario, ...] | None = None


async def load_subset_plan(
    session: AsyncSession,
    settings: Settings,
    target_id: uuid.UUID,
    scenario_ids: Sequence[uuid.UUID],
) -> RunPlanSource:
    target = await get_active_target(session, target_id)
    bundle = await resolve_plan_bundle(session, target, None, SUBSET_LOCATION)
    subset = await build_subset_plan(session, target, bundle, scenario_ids)
    validate_selection(subset.plan.selection, settings, SUBSET_LOCATION)
    return RunPlanSource(
        saved_plan=None,
        selection=subset.plan.selection,
        bundle=bundle,
        target=target,
        inline_name=subset.plan.name,
        plan_location=SUBSET_LOCATION,
        include_api_fuzz=False,
        subset=subset.scenarios,
    )


async def bundle_of_saved_plan(
    session: AsyncSession, plan: PlanRow, target: TargetRow
) -> BundleRow:
    if plan.is_coverage_baseline:
        return ensure_bundle_usable(await session.get(BundleRow, plan.bundle_id))
    return ensure_bundle_usable(await latest_valid_bundle(session, target.id))


async def load_run_plan(
    session: AsyncSession, settings: Settings, body: RunCreate
) -> RunPlanSource:
    if body.scenario_ids is not None and body.target_id is not None:
        return await load_subset_plan(session, settings, body.target_id, body.scenario_ids)
    if body.plan_id is not None:
        plan = await get_plan_row(session, body.plan_id)
        target = await get_active_target(session, plan.target_id)
        return RunPlanSource(
            saved_plan=plan,
            selection=PlanSelection.model_validate(plan.selection),
            bundle=await bundle_of_saved_plan(session, plan, target),
            target=target,
            inline_name=None,
            plan_location=BODY_LOCATION,
            include_api_fuzz=plan.include_api_fuzz,
        )
    inline = body.plan
    if inline is None:
        raise ApiError(422, "validation_failed", "Send exactly one of plan_id and plan")
    target = await get_active_target(session, inline.target_id)
    validate_selection(inline.selection, settings, INLINE_PLAN_LOCATION)
    bundle = await resolve_plan_bundle(session, target, inline.bundle_id, INLINE_PLAN_LOCATION)
    return RunPlanSource(
        saved_plan=None,
        selection=inline.selection,
        bundle=bundle,
        target=target,
        inline_name=inline.name,
        plan_location=INLINE_PLAN_LOCATION,
        include_api_fuzz=inline.include_api_fuzz,
    )


async def stage_run(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    user_id: uuid.UUID,
    body: RunCreate,
    origin: RunOrigin = MANUAL_ORIGIN,
) -> RunRow:
    source = await load_run_plan(session, settings, body)
    target, bundle = source.target, source.bundle
    evaluation = await evaluate_selection(
        session, settings, vault, target, bundle, source.selection
    )
    if source.subset is not None:
        evaluation = restrict_to_subset(evaluation, source.subset)
    await enforce_forced_tier(session, target, evaluation.assessment)
    ensure_production_allowed(target, evaluation.assessment)
    if not evaluation.expansion.cells:
        raise plan_empty_error(source.plan_location)
    ensure_environment_ready(evaluation.expansion.cells, evaluation.context)
    if body.reset_seed:
        await ensure_reset_seed_allowed(session, target, bundle, evaluation.assessment)
    if source.saved_plan is None:
        plan = insert_plan(
            session,
            target,
            bundle,
            user_id,
            source.inline_name,
            False,
            source.selection,
            evaluation.budget,
            source.include_api_fuzz,
        )
        budget = evaluation.budget
    else:
        plan = source.saved_plan
        if not plan.is_coverage_baseline:
            plan.bundle_id = bundle.id
        budget = Budget.model_validate(plan.budget)
    await session.flush()
    await materialize_cells(session, plan.id, evaluation.expansion.cells)
    run = new_run_row(
        origin.run_id or new_id(),
        plan,
        evaluation,
        origin.budget_for(budget),
        user_id,
        datetime.now(UTC),
        origin,
        body.scenario_ids,
    )
    session.add(run)
    await origin.record_run(session, run)
    return run


async def prepare_run(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    user_id: uuid.UUID,
    body: RunCreate,
    origin: RunOrigin = MANUAL_ORIGIN,
) -> PreparedRun:
    run = await stage_run(session, settings, vault, user_id, body, origin)
    await session.commit()
    effective = await effective_settings(session, settings)
    return PreparedRun(
        run=run,
        max_concurrency=resolve_concurrency(body.max_concurrency, effective),
        reset_seed=body.reset_seed,
    )


def run_created_event(run: RunRow) -> IngestEvent:
    payload = RunCreatedPayload(
        kind=run.kind,
        target_id=run.target_id,
        plan_id=run.plan_id,
        trigger=run.trigger,
        created_by=run.created_by,
        status=run.status,
    )
    return IngestEvent(
        run_id=run.id,
        type="run.created",
        payload=payload.model_dump(mode="json"),
        dedupe_key=RUN_CREATED_DEDUPE_KEY,
        occurred_at=run.created_at,
    )


def start_failure_events(run: RunRow, failed_at: datetime) -> list[IngestEvent]:
    changed = RunStatusChangedPayload(
        status=RunStatus.failed, previous=RunStatus.queued, reason=START_FAILED_REASON
    )
    duration_ms = max(round((failed_at - run.created_at).total_seconds() * 1000), 0)
    return [
        IngestEvent(
            run_id=run.id,
            type="run.status_changed",
            payload=changed.model_dump(mode="json"),
            dedupe_key=START_FAILED_STATUS_DEDUPE_KEY,
            occurred_at=failed_at,
        ),
        IngestEvent(
            run_id=run.id,
            type="run.finished",
            payload=run_finished_payload(RunStatus.failed, duration_ms),
            dedupe_key=START_FAILED_FINISHED_DEDUPE_KEY,
            occurred_at=failed_at,
        ),
    ]


async def record_start_failure(session_factory: SessionFactory, hub: Hub, run: RunRow) -> None:
    failed_at = datetime.now(UTC)
    try:
        async with session_factory() as session:
            await session.execute(
                update(RunRow)
                .where(RunRow.id == run.id, RunRow.status == RunStatus.queued)
                .values(status=RunStatus.failed, finished_at=failed_at)
            )
            await session.commit()
        await append_events(session_factory, hub, start_failure_events(run, failed_at))
    except Exception:
        logger.exception("run_start_failure_not_recorded", extra={"run_id": str(run.id)})


async def start_run(
    session: AsyncSession,
    session_factory: SessionFactory,
    hub: Hub,
    temporal: TemporalGateway,
    settings: Settings,
    vault: Vault,
    user_id: uuid.UUID,
    body: RunCreate,
    origin: RunOrigin = MANUAL_ORIGIN,
) -> RunHandle:
    prepared = await prepare_run(session, settings, vault, user_id, body, origin)
    run = prepared.run
    try:
        await append_events(session_factory, hub, [run_created_event(run)])
        await temporal.start_workflow(
            EXECUTE_RUN_WORKFLOW,
            ExecuteRunInput(
                run_id=run.id,
                max_concurrency=prepared.max_concurrency,
                reset_seed=prepared.reset_seed,
            ),
            run.workflow_id,
        )
    except Exception:
        await record_start_failure(session_factory, hub, run)
        raise
    return prepared.handle


def not_cancelable_error(message: str) -> ApiError:
    return ApiError(409, "run_not_cancelable", message)


async def request_cancel(
    session: AsyncSession, temporal: TemporalGateway, run_id: uuid.UUID
) -> RunRow:
    run = await get_run_row(session, run_id)
    if run.status in TERMINAL_RUN_STATUSES:
        raise not_cancelable_error(f"The run already ended with status {run.status.value}")
    if run.status is RunStatus.canceling:
        return run
    try:
        await temporal.signal_workflow(run.workflow_id, CANCEL_SIGNAL)
    except WorkflowNotRunningError:
        raise not_cancelable_error("The run's workflow is no longer running") from None
    return run
