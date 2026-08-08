from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from tessa_api.deps import SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.mutation import MutationSummary
from tessa_api.services.mutation_summary import summarize_mutation
from tessa_api.services.pagination import UnknownQueryRejected
from tessa_api.services.targets import get_target

router = APIRouter(tags=["mutation"])


@router.get(
    "/mutation/summary",
    response_model=MutationSummary,
    summary="Suite power: mutants killed, survivors and the kills per invariant",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_summary(
    user: ViewerUser,
    session: SessionDep,
    target_id: Annotated[UUID, Query(description="target whose mutants are summarised")],
) -> MutationSummary:
    await get_target(session, target_id)
    return await summarize_mutation(session, target_id)
