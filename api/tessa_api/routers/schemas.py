from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Request, Response

from tessa_api.errors import error_responses, not_found
from tessa_api.schemas.registry import SchemaIndex
from tessa_api.services.schema_registry import (
    SCHEMA_CACHE_CONTROL,
    SCHEMA_CONTENT_TYPE,
    SchemaStore,
    etag_matches,
    find_definition,
)

router = APIRouter(tags=["schemas"])

JSON_SCHEMA_RESPONSE: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "A JSON Schema document (draft 2020-12)",
        "content": {SCHEMA_CONTENT_TYPE: {"schema": {"type": "object"}}},
    },
    304: {"description": "The If-None-Match entity tag still matches"},
    **error_responses(404),
}


def get_schema_store(request: Request) -> SchemaStore:
    store: SchemaStore = request.app.state.schema_store
    return store


SchemaStoreDep = Annotated[SchemaStore, Depends(get_schema_store)]


@router.get(
    "/schemas/index.json",
    response_model=SchemaIndex,
    summary="Published JSON Schemas",
)
def read_schema_index(store: SchemaStoreDep) -> SchemaIndex:
    return store.index()


@router.get(
    "/schemas/{name}.v{version}.json",
    summary="One published JSON Schema",
    response_class=Response,
    responses=JSON_SCHEMA_RESPONSE,
)
def read_schema(
    name: str,
    version: int,
    store: SchemaStoreDep,
    if_none_match: Annotated[str | None, Header()] = None,
) -> Response:
    definition = find_definition(name, version)
    if definition is None:
        raise not_found(f"No published schema {name}.v{version}")
    served = store.serve(definition)
    headers = {"ETag": served.etag, "Cache-Control": SCHEMA_CACHE_CONTROL}
    if etag_matches(if_none_match, served.etag):
        return Response(status_code=304, headers=headers)
    return Response(content=served.body, media_type=SCHEMA_CONTENT_TYPE, headers=headers)
