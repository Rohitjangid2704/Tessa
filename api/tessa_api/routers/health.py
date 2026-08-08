from fastapi import APIRouter

from tessa_api.deps import SessionFactoryDep, SettingsDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.health import DependencyHealth, HealthStatus
from tessa_api.services.health import check_dependencies

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthStatus, summary="Liveness probe")
async def read_health() -> HealthStatus:
    return HealthStatus(status="ok")


@router.get(
    "/health/dependencies",
    response_model=DependencyHealth,
    summary="Status of database, Temporal, Laya and storage",
    responses=error_responses(401, 403),
)
async def read_dependencies(
    user: ViewerUser, settings: SettingsDep, session_factory: SessionFactoryDep
) -> DependencyHealth:
    return await check_dependencies(settings, session_factory)
