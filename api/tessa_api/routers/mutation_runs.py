from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
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
from tessa_api.schemas.mutation import MutationRun, MutationRunCreate, MutationRunPage
from tessa_api.services import mutation_runs
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query
from tessa_api.services.vault import VaultDep
from tessa_api.streams.dependencies import HubDep
from tessa_api.temporal_client import TemporalDep

router = APIRouter(tags=["mutation"])

MUTATION_RUN_SORT_KEYS = ("started_at",)
MutationRunPageQuery = Annotated[
    PageQuery, Depends(page_query(MUTATION_RUN_SORT_KEYS, "-started_at"))
]


@router.post(
    "/mutation-runs",
    status_code=202,
    response_model=RunHandle,
    summary="Run the suite against a deployed mutant; always blocked on a production target",
    responses=error_responses(400, 401, 403, 404, 409, 422, 503),
)
async def create_mutation_run(
    body: MutationRunCreate,
    user: MemberUser,
    idempotency: IdempotencyDep,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
    vault: VaultDep,
    hub: HubDep,
    temporal: TemporalDep,
) -> JSONResponse:
    handle = await mutation_runs.start_mutation_run(
        session, session_factory, hub, temporal, settings, vault, user.id, body
    )
    return await idempotency.respond(handle, 202)


@router.get(
    "/mutation-runs",
    response_model=MutationRunPage,
    summary="Mutation run history, newest first",
    responses=error_responses(401, 403, 422),
)
async def list_mutation_runs(
    user: ViewerUser,
    session: SessionDep,
    page: MutationRunPageQuery,
    target_id: Annotated[UUID | None, Query(description="only runs of this target")] = None,
    mutant_id: Annotated[UUID | None, Query(description="only runs of this mutant")] = None,
) -> MutationRunPage:
    return await mutation_runs.list_mutation_runs(session, page, target_id, mutant_id)


@router.get(
    "/mutation-runs/{mutation_run_id}",
    response_model=MutationRun,
    summary="Outcome per invariant of one mutation run; polled, not streamed",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_mutation_run(
    mutation_run_id: UUID, user: ViewerUser, session: SessionDep
) -> MutationRun:
    return await mutation_runs.read_mutation_run(session, mutation_run_id)
