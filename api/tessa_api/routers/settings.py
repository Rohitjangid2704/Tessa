from fastapi import APIRouter, Response

from tessa_api.deps import AdminUser, SessionDep, SettingsDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import AuditAction, AuditSubjectType, SecretName, ServiceName
from tessa_api.schemas.retention import (
    RETENTION_MAX_DAYS,
    RETENTION_MIN_DAYS,
    RetentionPolicy,
    RetentionState,
)
from tessa_api.schemas.settings import (
    SecretSet,
    SecretStatus,
    ServiceTestResult,
    SettingsPatch,
    SettingsRead,
)
from tessa_api.services import retention, settings_service
from tessa_api.services.audit import record_audit
from tessa_api.services.pagination import UnknownQueryRejected
from tessa_api.services.vault import VaultDep

router = APIRouter(tags=["settings"])


@router.get(
    "/settings",
    response_model=SettingsRead,
    summary="Models, thresholds, endpoints, budgets, overrides and secret status",
    responses=error_responses(401, 403),
    dependencies=[UnknownQueryRejected],
)
async def read_settings(
    user: ViewerUser, session: SessionDep, settings: SettingsDep
) -> SettingsRead:
    return await settings_service.read_settings(session, settings)


@router.patch(
    "/settings",
    response_model=SettingsRead,
    summary="Change settings per leaf; a leaf set to null removes its override",
    responses=error_responses(401, 403, 422),
)
async def update_settings(
    body: SettingsPatch, user: AdminUser, session: SessionDep, settings: SettingsDep
) -> SettingsRead:
    await settings_service.apply_settings_patch(session, user.id, body)
    await session.commit()
    return await settings_service.read_settings(session, settings)


@router.get(
    "/settings/retention",
    response_model=RetentionState,
    summary="The retention policy and what the last sweep did",
    responses=error_responses(401, 403),
    dependencies=[UnknownQueryRejected],
)
async def read_retention(
    user: AdminUser, session: SessionDep, settings: SettingsDep
) -> RetentionState:
    return await retention.read_retention_state(session, settings)


@router.put(
    "/settings/retention",
    response_model=RetentionPolicy,
    summary="Set how long step payloads, artifacts and run events are kept; every window is "
    f"between {RETENTION_MIN_DAYS} and {RETENTION_MAX_DAYS} days",
    responses=error_responses(401, 403, 422),
)
async def set_retention(
    body: RetentionPolicy, user: AdminUser, session: SessionDep, settings: SettingsDep
) -> RetentionPolicy:
    policy = await retention.apply_retention_policy(session, settings, user.id, body)
    await session.commit()
    return policy


@router.put(
    "/settings/secrets/{name}",
    response_model=SecretStatus,
    summary="Set a provider key or webhook secret; the value is never returned",
    responses=error_responses(401, 403, 422),
)
async def set_secret(
    name: SecretName, body: SecretSet, user: AdminUser, session: SessionDep, vault: VaultDep
) -> SecretStatus:
    actor_id = user.id
    status = await settings_service.store_secret(session, vault, actor_id, name, body.value)
    await record_audit(
        session,
        actor_id,
        AuditAction.secret_set,
        AuditSubjectType.secret,
        None,
        {"name": name.value},
    )
    await session.commit()
    return status


@router.delete(
    "/settings/secrets/{name}",
    status_code=204,
    response_class=Response,
    summary="Clear a secret so the environment value, if any, applies again",
    responses=error_responses(401, 403, 422),
)
async def delete_secret(name: SecretName, user: AdminUser, session: SessionDep) -> Response:
    actor_id = user.id
    if await settings_service.clear_secret(session, name):
        await record_audit(
            session,
            actor_id,
            AuditAction.secret_deleted,
            AuditSubjectType.secret,
            None,
            {"name": name.value},
        )
    await session.commit()
    return Response(status_code=204)


@router.post(
    "/settings/test/{service}",
    response_model=ServiceTestResult,
    summary="Connectivity test of one service with a free call; never echoes a key. The slack "
    "test posts a short message to the webhook",
    responses=error_responses(401, 403, 422),
    dependencies=[UnknownQueryRejected],
)
async def run_service_test(
    service: ServiceName,
    user: AdminUser,
    session: SessionDep,
    settings: SettingsDep,
    vault: VaultDep,
) -> ServiceTestResult:
    return await settings_service.run_service_test(session, vault, settings, service)
