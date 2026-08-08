from typing import Annotated, Any

from fastapi import APIRouter, Header, Response
from fastapi.responses import StreamingResponse

from tessa_api.errors import error_responses, not_found
from tessa_api.schemas.common import ErrorResponse
from tessa_api.services.artifact_store import ArtifactNotFoundError, RangeNotSatisfiableError
from tessa_api.services.artifacts import (
    ArtifactSignerDep,
    ArtifactStoreDep,
    ExpiredArtifactTokenError,
    InvalidArtifactTokenError,
    content_disposition,
    invalid_link_error,
    parse_range_header,
    range_not_satisfiable,
    resolve_requested_range,
)

router = APIRouter(tags=["artifacts"])

ARTIFACT_MEDIA_TYPES = ("image/png", "video/webm", "application/zip")
BINARY_CONTENT: dict[str, Any] = {
    media_type: {"schema": {"type": "string", "format": "binary"}}
    for media_type in ARTIFACT_MEDIA_TYPES
}
CACHE_CONTROL = "private, max-age=60"


@router.get(
    "/artifacts/{token}",
    response_class=Response,
    summary="Media bytes behind a signed ArtifactRef url",
    responses={
        200: {"description": "The artifact bytes", "content": BINARY_CONTENT},
        206: {"description": "A byte range of the artifact", "content": BINARY_CONTENT},
        416: {"model": ErrorResponse, "description": "The range lies outside the artifact"},
        **error_responses(403, 404),
    },
)
async def read_artifact(
    token: str,
    store: ArtifactStoreDep,
    signer: ArtifactSignerDep,
    range_header: Annotated[str | None, Header(alias="Range")] = None,
) -> Response:
    try:
        link = signer.verify(token)
    except (InvalidArtifactTokenError, ExpiredArtifactTokenError):
        raise invalid_link_error() from None
    try:
        stored = await store.info(link.artifact_id)
        requested = resolve_requested_range(parse_range_header(range_header), stored.size_bytes)
        chunks = await store.open(link.artifact_id, requested)
    except ArtifactNotFoundError:
        raise not_found("The artifact is no longer stored") from None
    except RangeNotSatisfiableError as error:
        raise range_not_satisfiable(error.size_bytes) from None
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(chunks.length),
        "Content-Disposition": content_disposition(stored),
        "Cache-Control": CACHE_CONTROL,
        "X-Content-Type-Options": "nosniff",
    }
    partial = requested is not None
    if partial:
        headers["Content-Range"] = f"bytes {chunks.start}-{chunks.end}/{stored.size_bytes}"
    return StreamingResponse(
        chunks.chunks,
        status_code=206 if partial else 200,
        media_type=stored.mime,
        headers=headers,
    )
