from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from tessa_api.deps import (
    IdempotencyDep,
    MemberUser,
    SessionDep,
    SessionFactoryDep,
    SettingsDep,
    ViewerUser,
)
from tessa_api.errors import error_responses
from tessa_api.schemas.common import RunHandle
from tessa_api.schemas.enums import SeedAction
from tessa_api.schemas.seeds import Seed, SeedPage, SeedResetCreate, SeedVerifyCreate
from tessa_api.services import seeds as seed_service
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query
from tessa_api.services.seeds import SeedRunRequest
from tessa_api.services.vault import VaultDep
from tessa_api.streams.dependencies import HubDep
from tessa_api.temporal_client import TemporalDep

router = APIRouter(tags=["seeds"])

SEED_SORT_KEYS = ("version",)
SeedPageQuery = Annotated[PageQuery, Depends(page_query(SEED_SORT_KEYS, "-version"))]


@router.get(
    "/targets/{target_id}/seeds",
    response_model=SeedPage,
    summary="Seed versions of a target with their hashes",
    responses=error_responses(401, 403, 404, 422),
)
async def list_target_seeds(
    target_id: UUID, user: ViewerUser, session: SessionDep, page: SeedPageQuery
) -> SeedPage:
    return await seed_service.list_target_seeds(session, target_id, page)


@router.get(
    "/seeds/{seed_id}",
    response_model=Seed,
    summary="One seed version",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_seed(seed_id: UUID, user: ViewerUser, session: SessionDep) -> Seed:
    return await seed_service.read_seed(session, seed_id)


@router.post(
    "/targets/{target_id}/seeds/verify",
    status_code=202,
    response_model=RunHandle,
    summary="Run the hash command of a seed and compare it with the expected hash",
    responses=error_responses(400, 401, 403, 404, 409, 422, 503),
)
async def verify_seed(
    target_id: UUID,
    body: SeedVerifyCreate,
    user: MemberUser,
    idempotency: IdempotencyDep,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
    vault: VaultDep,
    hub: HubDep,
    temporal: TemporalDep,
) -> JSONResponse:
    handle = await seed_service.start_seed_run(
        session,
        session_factory,
        hub,
        temporal,
        settings,
        vault,
        user.id,
        target_id,
        SeedRunRequest(SeedAction.verify, body.seed_id, None),
    )
    return await idempotency.respond(handle, 202)


@router.post(
    "/targets/{target_id}/seeds/reset",
    status_code=202,
    response_model=RunHandle,
    summary="Reset the target to a seed after the user typed the target name",
    responses=error_responses(400, 401, 403, 404, 409, 422, 503),
)
async def reset_seed(
    target_id: UUID,
    body: SeedResetCreate,
    user: MemberUser,
    idempotency: IdempotencyDep,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
    vault: VaultDep,
    hub: HubDep,
    temporal: TemporalDep,
) -> JSONResponse:
    handle = await seed_service.start_seed_run(
        session,
        session_factory,
        hub,
        temporal,
        settings,
        vault,
        user.id,
        target_id,
        SeedRunRequest(SeedAction.reset, body.seed_id, body.confirm_target_name),
    )
    return await idempotency.respond(handle, 202)
