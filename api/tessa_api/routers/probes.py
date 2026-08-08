from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from tessa_api.deps import SessionDep, SettingsDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import InvariantPack
from tessa_api.schemas.probes import ProbePage
from tessa_api.services.pagination import PageQuery, page_query
from tessa_api.services.probe_listing import list_probe_page

router = APIRouter(tags=["probes"])

PROBE_SORT_KEYS = ("pack", "id")
ProbePageQuery = Annotated[PageQuery, Depends(page_query(PROBE_SORT_KEYS, "pack,id"))]


@router.get(
    "/probes",
    response_model=ProbePage,
    summary="Probe bank listing for Settings and the probe panel legend",
    responses=error_responses(401, 403, 404, 422, 500),
)
async def list_probes(
    user: ViewerUser,
    session: SessionDep,
    settings: SettingsDep,
    page: ProbePageQuery,
    pack: Annotated[
        list[InvariantPack] | None, Query(description="only probes of these packs")
    ] = None,
    q: Annotated[str | None, Query(max_length=200, description="text search")] = None,
    target_id: Annotated[
        UUID | None,
        Query(description="also list the probes derived from the latest valid bundle of a target"),
    ] = None,
) -> ProbePage:
    return await list_probe_page(session, settings, page, pack or (), q, target_id)
