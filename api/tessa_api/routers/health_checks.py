from uuid import UUID

from fastapi import APIRouter

from tessa_api.deps import MemberUser, SessionDep, SettingsDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.health import HealthCheckCreate, HealthReport
from tessa_api.services import health_checks as health_check_service
from tessa_api.services import targets as target_service
from tessa_api.services.vault import VaultDep

router = APIRouter(tags=["health-checks"])


@router.post(
    "/targets/{target_id}/health-checks",
    response_model=HealthReport,
    summary="Check every interface of the target now",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def create_health_check(
    target_id: UUID,
    user: MemberUser,
    session: SessionDep,
    settings: SettingsDep,
    vault: VaultDep,
    body: HealthCheckCreate | None = None,
) -> HealthReport:
    target = await target_service.get_active_target(session, target_id)
    interface_ids = body.interface_ids if body is not None else None
    report = await health_check_service.run_health_checks(
        session, settings, vault, target, interface_ids
    )
    await session.commit()
    return report


@router.get(
    "/targets/{target_id}/health",
    response_model=HealthReport,
    summary="Last stored health report of the target",
    responses=error_responses(401, 403, 404),
)
async def read_health_report(
    target_id: UUID, user: ViewerUser, session: SessionDep
) -> HealthReport:
    target = await target_service.get_target(session, target_id)
    return health_check_service.stored_report(target)
