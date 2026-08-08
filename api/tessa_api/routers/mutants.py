from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from tessa_api.deps import MemberUser, SessionDep, SettingsDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import MutantStatus
from tessa_api.schemas.mutants import Mutant, MutantCreate, MutantPage, MutantUpdate
from tessa_api.services import mutants as mutant_service
from tessa_api.services.pagination import PageQuery, page_query

router = APIRouter(tags=["mutants"])

MUTANT_SORT_KEYS = ("created_at", "name")
MutantPageQuery = Annotated[PageQuery, Depends(page_query(MUTANT_SORT_KEYS, "-created_at"))]


@router.get(
    "/mutants",
    response_model=MutantPage,
    summary="Mutant catalogue: known bugs and the invariants that should catch them",
    responses=error_responses(401, 403, 422),
)
async def list_mutants(
    user: ViewerUser,
    session: SessionDep,
    page: MutantPageQuery,
    target_id: Annotated[UUID | None, Query(description="only mutants of this target")] = None,
    status: Annotated[list[MutantStatus] | None, Query()] = None,
) -> MutantPage:
    return await mutant_service.list_mutants(session, page, target_id, status or ())


@router.post(
    "/mutants",
    status_code=201,
    response_model=Mutant,
    summary="Register a mutant Claude Code created; the name is unique per target",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def create_mutant(
    body: MutantCreate, user: MemberUser, session: SessionDep, settings: SettingsDep
) -> Mutant:
    return await mutant_service.create_mutant(session, settings, user, body)


@router.patch(
    "/mutants/{mutant_id}",
    response_model=Mutant,
    summary="Edit, mark deployed or retire a mutant",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def update_mutant(
    mutant_id: UUID,
    body: MutantUpdate,
    user: MemberUser,
    session: SessionDep,
    settings: SettingsDep,
) -> Mutant:
    return await mutant_service.update_mutant(session, settings, mutant_id, body)


@router.delete(
    "/mutants/{mutant_id}",
    status_code=204,
    summary="Delete a mutant that no mutation run is using",
    responses=error_responses(401, 403, 404, 409),
)
async def delete_mutant(mutant_id: UUID, user: MemberUser, session: SessionDep) -> Response:
    await mutant_service.delete_mutant(session, mutant_id)
    return Response(status_code=204)
