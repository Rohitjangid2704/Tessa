import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, RunRow, SeedRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.db.session import SessionFactory
from tessa_api.errors import ApiError, not_found
from tessa_api.ids import new_id
from tessa_api.schemas.common import Budget, ErrorDetail, RunHandle
from tessa_api.schemas.enums import RunKind, RunStatus, RunTrigger, SeedAction
from tessa_api.schemas.seeds import Seed, SeedPage
from tessa_api.schemas.temporal import (
    SEED_TARGET_WORKFLOW,
    SeedTargetInput,
    seed_target_workflow_id,
)
from tessa_api.services.hello import zero_run_counters
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.run_guard import (
    assess_production,
    enforce_forced_tier,
    ensure_no_conflicting_run,
    seed_not_ready_error,
)
from tessa_api.services.run_service import (
    initial_config_snapshot,
    record_start_failure,
    run_created_event,
)
from tessa_api.services.settings_service import effective_settings
from tessa_api.services.targets import get_active_target, get_target
from tessa_api.services.vault import Vault
from tessa_api.settings import Settings
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import append_events
from tessa_api.temporal_client import TemporalGateway

SEED_SORT_COLUMNS: dict[str, SortableColumn] = {"version": sortable(SeedRow.version, int)}
SEED_ID_COLUMN = sortable(SeedRow.id, uuid.UUID)


@dataclass(frozen=True, slots=True)
class SeedRunRequest:
    action: SeedAction
    seed_id: uuid.UUID | None
    confirm_target_name: str | None


def to_seed(row: SeedRow) -> Seed:
    return Seed(
        id=row.id,
        target_id=row.target_id,
        bundle_id=row.bundle_id,
        version=row.version,
        declared_hash=row.declared_hash,
        hash_source=row.hash_source,
        observed_hash=row.observed_hash,
        last_reset_at=row.last_reset_at,
        last_reset_status=row.last_reset_status,
        last_reset_run_id=row.last_reset_run_id,
        has_reset_script=row.reset_script_path is not None,
        has_hash_command=row.hash_command is not None,
        reset_script_path=row.reset_script_path,
        hash_command=row.hash_command,
        material_sha256=row.material_sha256,
    )


async def list_target_seeds(
    session: AsyncSession, target_id: uuid.UUID, query: PageQuery
) -> SeedPage:
    await get_target(session, target_id)
    page = await paginate(
        session,
        select(SeedRow).where(SeedRow.target_id == target_id),
        SEED_SORT_COLUMNS,
        SEED_ID_COLUMN,
        query,
    )
    return SeedPage(
        items=[to_seed(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def get_seed_row(session: AsyncSession, seed_id: uuid.UUID) -> SeedRow:
    seed = await session.get(SeedRow, seed_id)
    if seed is None:
        raise not_found("Seed not found")
    return seed


async def read_seed(session: AsyncSession, seed_id: uuid.UUID) -> Seed:
    return to_seed(await get_seed_row(session, seed_id))


def production_seed_error(target_name: str) -> ApiError:
    return ApiError(
        409,
        "production_blocked",
        f"{target_name} is a production target; seeds are never verified or reset there",
        [
            ErrorDetail(
                loc=["target", "tier"],
                code="production_blocked",
                message="Seed verify and reset write to or probe the target and are always "
                "blocked on production",
            )
        ],
    )


def confirmation_mismatch_error() -> ApiError:
    message = "confirm_target_name must equal the exact name of the target"
    return ApiError(
        422,
        "confirmation_mismatch",
        message,
        [
            ErrorDetail(
                loc=["body", "confirm_target_name"], code="confirmation_mismatch", message=message
            )
        ],
    )


async def resolve_seed(
    session: AsyncSession, target_id: uuid.UUID, seed_id: uuid.UUID | None
) -> SeedRow:
    if seed_id is not None:
        seed = await get_seed_row(session, seed_id)
        if seed.target_id != target_id:
            raise not_found("Seed not found")
        return seed
    latest = await session.scalar(
        select(SeedRow)
        .where(SeedRow.target_id == target_id)
        .order_by(SeedRow.version.desc())
        .limit(1)
    )
    if latest is None:
        raise seed_not_ready_error(
            "id",
            "seed_missing",
            "The target has no seed material; upload a bundle that declares seeds",
        )
    return latest


def ensure_seed_can_run(seed: SeedRow, action: SeedAction) -> None:
    if action is SeedAction.verify and seed.hash_command is None:
        raise seed_not_ready_error(
            "hash_command", "hook_missing", "The seed has no hash command to run"
        )
    if action is SeedAction.reset and seed.reset_script_path is None:
        raise seed_not_ready_error(
            "reset_script_path", "hook_missing", "The seed has no reset script to run"
        )


def new_seed_run(
    target: TargetRow, seed: SeedRow, bundle: BundleRow, settings: Settings, user_id: uuid.UUID
) -> RunRow:
    run_id = new_id()
    budget = Budget(max_usd=0.0, max_minutes=settings.run_default_max_minutes)
    return RunRow(
        id=run_id,
        kind=RunKind.seed,
        target_id=target.id,
        plan_id=None,
        bundle_id=bundle.id,
        status=RunStatus.queued,
        trigger=RunTrigger.manual,
        read_only=False,
        config_snapshot=initial_config_snapshot(bundle).model_dump(mode="json"),
        budget=budget.model_dump(mode="json"),
        counters=zero_run_counters().model_dump(mode="json"),
        workflow_id=seed_target_workflow_id(run_id),
        created_by=user_id,
        created_at=datetime.now(UTC),
    )


def to_handle(run: RunRow) -> RunHandle:
    return RunHandle(
        run_id=run.id,
        workflow_id=run.workflow_id,
        kind=run.kind,
        status=run.status,
        created_at=run.created_at,
    )


async def prepare_seed_run(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    user_id: uuid.UUID,
    target_id: uuid.UUID,
    request: SeedRunRequest,
) -> tuple[RunRow, SeedTargetInput]:
    target = await get_active_target(session, target_id)
    assessment = await assess_production(session, settings, vault, target)
    await enforce_forced_tier(session, target, assessment)
    if assessment.production:
        raise production_seed_error(target.name)
    if request.action is SeedAction.reset and request.confirm_target_name != target.name:
        raise confirmation_mismatch_error()
    seed = await resolve_seed(session, target.id, request.seed_id)
    ensure_seed_can_run(seed, request.action)
    if request.action is SeedAction.reset:
        await ensure_no_conflicting_run(session, target.id)
    bundle = await session.get(BundleRow, seed.bundle_id)
    if bundle is None:
        raise not_found("Bundle of the seed not found")
    run = new_seed_run(target, seed, bundle, await effective_settings(session, settings), user_id)
    session.add(run)
    await session.commit()
    workflow_input = SeedTargetInput(
        run_id=run.id, target_id=target.id, seed_id=seed.id, action=request.action
    )
    return run, workflow_input


async def start_seed_run(
    session: AsyncSession,
    session_factory: SessionFactory,
    hub: Hub,
    temporal: TemporalGateway,
    settings: Settings,
    vault: Vault,
    user_id: uuid.UUID,
    target_id: uuid.UUID,
    request: SeedRunRequest,
) -> RunHandle:
    run, workflow_input = await prepare_seed_run(
        session, settings, vault, user_id, target_id, request
    )
    try:
        await append_events(session_factory, hub, [run_created_event(run)])
        await temporal.start_workflow(SEED_TARGET_WORKFLOW, workflow_input, run.workflow_id)
    except Exception:
        await record_start_failure(session_factory, hub, run)
        raise
    return to_handle(run)
