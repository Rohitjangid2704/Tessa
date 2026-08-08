from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from tessa_api.deps import SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.catalog import Catalog, CatalogItem
from tessa_api.schemas.enums import Confidence, FeatureKind
from tessa_api.services import catalog_builder
from tessa_api.services import proposals as proposal_service
from tessa_api.services.catalog_builder import CatalogFilters
from tessa_api.services.pagination import UnknownQueryRejected

router = APIRouter(tags=["catalog"])


@router.get(
    "/catalog",
    response_model=Catalog,
    summary="Catalog tree of the latest valid bundle of a target",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_catalog(
    user: ViewerUser,
    session: SessionDep,
    target_id: Annotated[UUID, Query(description="target to read the catalog of")],
    bundle_id: Annotated[UUID | None, Query(description="default is the latest valid")] = None,
    area: Annotated[list[str] | None, Query()] = None,
    kind: Annotated[list[FeatureKind] | None, Query()] = None,
    role: Annotated[list[str] | None, Query(description="matches roles including all")] = None,
    interface_id: Annotated[list[str] | None, Query()] = None,
    confidence: Annotated[list[Confidence] | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
) -> Catalog:
    filters = CatalogFilters(
        areas=area or (),
        kinds=kind or (),
        roles=role or (),
        interface_ids=interface_id or (),
        confidences=confidence or (),
        query=q,
    )
    catalog = await catalog_builder.read_catalog(session, target_id, bundle_id, filters)
    return await proposal_service.annotate_catalog(session, target_id, catalog)


@router.get(
    "/catalog/items/{catalog_item_id}",
    response_model=CatalogItem,
    summary="One feature with its examples",
    responses=error_responses(401, 403, 404),
)
async def read_catalog_item(
    catalog_item_id: UUID, user: ViewerUser, session: SessionDep
) -> CatalogItem:
    return await catalog_builder.read_catalog_item(session, catalog_item_id)
