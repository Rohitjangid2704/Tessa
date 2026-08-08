from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from tessa_api.deps import SettingsDep, StreamGuardDep, StreamViewerRequired
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import FeedName, RunKind
from tessa_api.services.pagination import UnknownQueryRejected
from tessa_api.streams.dependencies import HubDep
from tessa_api.streams.feeds import (
    SSE_HEADERS,
    SSE_MEDIA_TYPE,
    FeedFilters,
    RunDirectoryDep,
    feed_stream,
)

router = APIRouter(tags=["feeds"])


@router.get(
    "/feeds/runs",
    response_class=StreamingResponse,
    summary="Server-sent events for the Runs list",
    responses={
        200: {
            "description": "Event stream: stream.hello first, then run and budget events",
            "content": {SSE_MEDIA_TYPE: {"schema": {"type": "string"}}},
        },
        **error_responses(401, 403, 422),
    },
    dependencies=[StreamViewerRequired, UnknownQueryRejected],
)
async def stream_runs_feed(
    hub: HubDep,
    settings: SettingsDep,
    directory: RunDirectoryDep,
    guard: StreamGuardDep,
    target_id: Annotated[UUID | None, Query(description="only runs of this target")] = None,
    kind: Annotated[list[RunKind] | None, Query(description="only runs of these kinds")] = None,
    run_id: Annotated[UUID | None, Query(description="only events of this run")] = None,
) -> StreamingResponse:
    filters = FeedFilters(target_id=target_id, kinds=frozenset(kind or ()), run_id=run_id)
    return StreamingResponse(
        feed_stream(hub, settings, directory, FeedName.runs, filters, guard),
        media_type=SSE_MEDIA_TYPE,
        headers=SSE_HEADERS,
    )


@router.get(
    "/feeds/findings",
    response_class=StreamingResponse,
    summary="Server-sent events for the Findings board",
    responses={
        200: {
            "description": "Event stream: stream.hello first, then finding events",
            "content": {SSE_MEDIA_TYPE: {"schema": {"type": "string"}}},
        },
        **error_responses(401, 403, 422),
    },
    dependencies=[StreamViewerRequired, UnknownQueryRejected],
)
async def stream_findings_feed(
    hub: HubDep,
    settings: SettingsDep,
    directory: RunDirectoryDep,
    guard: StreamGuardDep,
    target_id: Annotated[UUID | None, Query(description="only findings of this target")] = None,
) -> StreamingResponse:
    return StreamingResponse(
        feed_stream(
            hub, settings, directory, FeedName.findings, FeedFilters(target_id=target_id), guard
        ),
        media_type=SSE_MEDIA_TYPE,
        headers=SSE_HEADERS,
    )


@router.get(
    "/feeds/coverage",
    response_class=StreamingResponse,
    summary="Server-sent events for the Coverage page",
    responses={
        200: {
            "description": "Event stream: stream.hello first, then coverage and generation events",
            "content": {SSE_MEDIA_TYPE: {"schema": {"type": "string"}}},
        },
        **error_responses(401, 403, 422),
    },
    dependencies=[StreamViewerRequired, UnknownQueryRejected],
)
async def stream_coverage_feed(
    hub: HubDep,
    settings: SettingsDep,
    directory: RunDirectoryDep,
    guard: StreamGuardDep,
    target_id: Annotated[UUID | None, Query(description="only coverage of this target")] = None,
) -> StreamingResponse:
    return StreamingResponse(
        feed_stream(
            hub, settings, directory, FeedName.coverage, FeedFilters(target_id=target_id), guard
        ),
        media_type=SSE_MEDIA_TYPE,
        headers=SSE_HEADERS,
    )


@router.get(
    "/feeds/home",
    response_class=StreamingResponse,
    summary="Server-sent events for the Home dashboard",
    responses={
        200: {
            "description": "Event stream: stream.hello first, then run, finding, budget, "
            "notification and dashboard events",
            "content": {SSE_MEDIA_TYPE: {"schema": {"type": "string"}}},
        },
        **error_responses(401, 403, 422),
    },
    dependencies=[StreamViewerRequired, UnknownQueryRejected],
)
async def stream_home_feed(
    hub: HubDep,
    settings: SettingsDep,
    directory: RunDirectoryDep,
    guard: StreamGuardDep,
    target_id: Annotated[UUID | None, Query(description="only events of this target")] = None,
) -> StreamingResponse:
    return StreamingResponse(
        feed_stream(
            hub, settings, directory, FeedName.home, FeedFilters(target_id=target_id), guard
        ),
        media_type=SSE_MEDIA_TYPE,
        headers=SSE_HEADERS,
    )
