from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from tessa_api.deps import SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import InvariantPack
from tessa_api.schemas.invariants import InvariantCatalog
from tessa_api.services.invariants.catalog import list_catalog
from tessa_api.services.pagination import UnknownQueryRejected

router = APIRouter(tags=["invariants"])


@router.get(
    "/invariants",
    response_model=InvariantCatalog,
    summary="Invariant catalog for filters and result labels",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def list_invariants(
    user: ViewerUser,
    session: SessionDep,
    pack: Annotated[list[InvariantPack] | None, Query(description="only these packs")] = None,
    target_id: Annotated[
        UUID | None, Query(description="adds the target pack declared by the target's bundle")
    ] = None,
) -> InvariantCatalog:
    return await list_catalog(session, pack or (), target_id)
