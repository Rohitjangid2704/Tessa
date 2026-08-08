from uuid import UUID

from fastapi import APIRouter

from tessa_api.deps import SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.steps import Step
from tessa_api.services import run_views
from tessa_api.services.artifacts import ArtifactSignerDep
from tessa_api.services.pagination import UnknownQueryRejected

router = APIRouter(tags=["steps"])


@router.get(
    "/steps/{step_id}",
    response_model=Step,
    summary="Step inspector: payloads, tier 0 result and signed artifact links",
    responses=error_responses(401, 403, 404),
    dependencies=[UnknownQueryRejected],
)
async def read_step(
    step_id: UUID, user: ViewerUser, session: SessionDep, signer: ArtifactSignerDep
) -> Step:
    return await run_views.read_step(session, signer, step_id)
