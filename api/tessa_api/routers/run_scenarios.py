from uuid import UUID

from fastapi import APIRouter

from tessa_api.deps import SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.runs import RunScenario
from tessa_api.services import run_views
from tessa_api.services.pagination import UnknownQueryRejected

router = APIRouter(tags=["run_scenarios"])


@router.get(
    "/run-scenarios/{run_scenario_id}",
    response_model=RunScenario,
    summary="A scenario execution with its attempts and step summaries",
    responses=error_responses(401, 403, 404),
    dependencies=[UnknownQueryRejected],
)
async def read_run_scenario(
    run_scenario_id: UUID, user: ViewerUser, session: SessionDep
) -> RunScenario:
    return await run_views.read_run_scenario(session, run_scenario_id)
