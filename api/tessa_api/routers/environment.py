from uuid import UUID

from fastapi import APIRouter

from tessa_api.deps import MemberUser, SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.environment import EnvironmentList, EnvironmentPatch
from tessa_api.services import environment as environment_service
from tessa_api.services import targets as target_service
from tessa_api.services.vault import VaultDep

router = APIRouter(tags=["environment"])


@router.get(
    "/targets/{target_id}/environment",
    response_model=EnvironmentList,
    summary="Environment variables of a target; secret values are never returned",
    responses=error_responses(401, 403, 404),
)
async def read_environment(
    target_id: UUID, user: ViewerUser, session: SessionDep, vault: VaultDep
) -> EnvironmentList:
    await target_service.get_target(session, target_id)
    return await environment_service.list_environment(session, vault, target_id)


@router.patch(
    "/targets/{target_id}/environment",
    response_model=EnvironmentList,
    summary="Save or clear variable values; write-only",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def patch_environment(
    target_id: UUID,
    body: EnvironmentPatch,
    user: MemberUser,
    session: SessionDep,
    vault: VaultDep,
) -> EnvironmentList:
    await target_service.get_active_target(session, target_id)
    await environment_service.apply_environment_patch(session, vault, target_id, user.id, body)
    await session.commit()
    return await environment_service.list_environment(session, vault, target_id)
