from fastapi import APIRouter

from tessa_api.deps import ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.targets import AppKindList
from tessa_api.services.app_kinds import list_app_kinds as build_app_kind_list

router = APIRouter(tags=["app-kinds"])


@router.get(
    "/app-kinds",
    response_model=AppKindList,
    summary="App kinds with the hints of the Discovery prompt",
    responses=error_responses(401, 403),
)
async def list_app_kinds(user: ViewerUser) -> AppKindList:
    return build_app_kind_list()
