import re
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, EnvironmentRow, RunRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import (
    BundleValidationStatus,
    EnvVarKind,
    RunKind,
    RunStatus,
    SkipReason,
    TargetTier,
)
from tessa_api.services.environment import resolve_values
from tessa_api.services.plan_builder import PlannedCell, PlanningContext
from tessa_api.services.seed_resolution import seed_in_force
from tessa_api.services.vault import Vault
from tessa_api.settings import Settings

CELL_SKIPS_THAT_NEED_NO_ENVIRONMENT = frozenset(
    {SkipReason.adapter_unsupported, SkipReason.production_blocked, SkipReason.hook_missing}
)
ACTIVE_RUN_STATUSES = (
    RunStatus.queued,
    RunStatus.planning,
    RunStatus.seeding,
    RunStatus.running,
    RunStatus.canceling,
)
RESET_BLOCKING_KINDS = (RunKind.suite, RunKind.seed)


@dataclass(frozen=True, slots=True)
class ProductionAssessment:
    production: bool
    forced_by_url: bool
    allow_production: bool

    @property
    def blocked(self) -> bool:
        return self.production and not self.allow_production


async def url_values_match_production(
    session: AsyncSession, settings: Settings, vault: Vault, target_id: uuid.UUID
) -> bool:
    patterns = [re.compile(pattern) for pattern in settings.production_url_patterns]
    if not patterns:
        return False
    names = (
        await session.scalars(
            select(EnvironmentRow.name).where(
                EnvironmentRow.target_id == target_id,
                EnvironmentRow.kind == EnvVarKind.url,
                EnvironmentRow.stale.is_(False),
                EnvironmentRow.encrypted_value.is_not(None),
            )
        )
    ).all()
    if not names:
        return False
    values = await resolve_values(session, vault, target_id, names=names)
    return any(
        pattern.search(value.get_secret_value())
        for value in values.values()
        for pattern in patterns
    )


async def assess_production(
    session: AsyncSession, settings: Settings, vault: Vault, target: TargetRow
) -> ProductionAssessment:
    forced = await url_values_match_production(session, settings, vault, target.id)
    return ProductionAssessment(
        production=target.tier is TargetTier.production or forced,
        forced_by_url=forced,
        allow_production=target.allow_production,
    )


async def enforce_forced_tier(
    session: AsyncSession, target: TargetRow, assessment: ProductionAssessment
) -> None:
    if assessment.forced_by_url and target.tier is not TargetTier.production:
        target.tier = TargetTier.production
        await session.commit()


def production_blocked_error(target_name: str) -> ApiError:
    return ApiError(
        409,
        "production_blocked",
        f"{target_name} is a production target and does not allow runs yet",
        [
            ErrorDetail(
                loc=["target", "allow_production"],
                code="production_blocked",
                message="An admin must enable allow_production for this target",
            )
        ],
    )


def ensure_production_allowed(target: TargetRow, assessment: ProductionAssessment) -> None:
    if assessment.blocked:
        raise production_blocked_error(target.name)


def bundle_missing_error() -> ApiError:
    return ApiError(
        409,
        "target_not_ready",
        "The target has no valid bundle yet; upload one first",
        [
            ErrorDetail(
                loc=["bundle"], code="bundle_missing", message="The target has no valid bundle"
            )
        ],
    )


def ensure_bundle_usable(bundle: BundleRow | None) -> BundleRow:
    if bundle is None or bundle.validation_status is not BundleValidationStatus.valid:
        raise bundle_missing_error()
    return bundle


def environment_problems(
    cells: Iterable[PlannedCell], context: PlanningContext
) -> list[ErrorDetail]:
    problems: list[ErrorDetail] = []
    seen_variables: set[str] = set()
    seen_interfaces: set[str] = set()
    for cell in cells:
        if cell.skip_reason in CELL_SKIPS_THAT_NEED_NO_ENVIRONMENT:
            continue
        requirements = context.requirements(cell.role, cell.interface_id)
        if requirements.address_missing and cell.interface_id not in seen_interfaces:
            seen_interfaces.add(cell.interface_id)
            problems.append(
                ErrorDetail(
                    loc=["interface", cell.interface_id],
                    code="interface_url_missing",
                    message=f"No url variable lists interface {cell.interface_id}",
                )
            )
        for variable in requirements.missing_required():
            if variable.name in seen_variables:
                continue
            seen_variables.add(variable.name)
            problems.append(
                ErrorDetail(
                    loc=["environment", variable.name],
                    code="env_missing",
                    message=f"Required variable {variable.name} has no value",
                )
            )
    return problems


def ensure_environment_ready(cells: Sequence[PlannedCell], context: PlanningContext) -> None:
    problems = environment_problems(cells, context)
    if not problems:
        return
    count = sum(1 for problem in problems if problem.loc[0] == "environment")
    message = (
        f"{count} required environment variable{'' if count == 1 else 's'} "
        f"{'has' if count == 1 else 'have'} no value"
        if count
        else "The target cannot be reached: an interface has no url variable"
    )
    raise ApiError(409, "target_not_ready", message, problems)


def seed_not_ready_error(location: str, code: str, message: str) -> ApiError:
    return ApiError(
        409,
        "target_not_ready",
        message,
        [ErrorDetail(loc=["seed", location], code=code, message=message)],
    )


async def ensure_no_conflicting_run(session: AsyncSession, target_id: uuid.UUID) -> None:
    blocking = await session.scalar(
        select(RunRow.id)
        .where(
            RunRow.target_id == target_id,
            RunRow.kind.in_(RESET_BLOCKING_KINDS),
            RunRow.status.in_(ACTIVE_RUN_STATUSES),
        )
        .limit(1)
    )
    if blocking is not None:
        raise ApiError(
            409,
            "conflict",
            "A suite or seed run of this target is still active; wait for it or cancel it "
            "before resetting",
            [
                ErrorDetail(
                    loc=["target", "runs"],
                    code="active_run",
                    message=f"Run {blocking} is still active",
                )
            ],
        )


def production_reset_error(target_name: str) -> ApiError:
    return ApiError(
        409,
        "production_blocked",
        f"{target_name} is a production target; its seed is never reset before a run",
        [
            ErrorDetail(
                loc=["body", "reset_seed"],
                code="production_blocked",
                message="reset_seed writes to the target and is always blocked on production",
            )
        ],
    )


async def ensure_reset_seed_allowed(
    session: AsyncSession,
    target: TargetRow,
    bundle: BundleRow,
    assessment: ProductionAssessment,
) -> None:
    if assessment.production:
        raise production_reset_error(target.name)
    seed = await seed_in_force(session, bundle)
    if seed is None:
        raise seed_not_ready_error(
            "id",
            "seed_missing",
            "The bundle declares no seed material, so there is nothing to reset",
        )
    if seed.reset_script_path is None:
        raise seed_not_ready_error(
            "reset_script_path", "hook_missing", "The seed has no reset script to run"
        )
    await ensure_no_conflicting_run(session, target.id)
