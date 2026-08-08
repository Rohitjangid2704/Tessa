from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import JSONResponse

from tessa_api.deps import (
    MemberUser,
    OptionalIdempotencyDep,
    SessionDep,
    SessionFactoryDep,
    SettingsDep,
    ViewerUser,
)
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import LabelReason, LabelSource, LabelSubjectType
from tessa_api.schemas.labels import Label, LabelCreate, LabelPage, LabelStats, LabelTaskPage
from tessa_api.services import labels as label_service
from tessa_api.services.labels import LabelFilters, QueueFilters
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query
from tessa_api.streams.dependencies import HubDep

router = APIRouter(tags=["labels"])

LABEL_QUEUE_SORT_KEYS = ("created_at",)
LABEL_SORT_KEYS = ("labeled_at",)
LabelQueuePageQuery = Annotated[
    PageQuery, Depends(page_query(LABEL_QUEUE_SORT_KEYS, "-created_at"))
]
LabelPageQuery = Annotated[PageQuery, Depends(page_query(LABEL_SORT_KEYS, "-labeled_at"))]


@router.get(
    "/queue",
    response_model=LabelTaskPage,
    summary="Fast review queue of subjects that need a human label",
    responses=error_responses(401, 403, 422),
)
async def list_label_queue(
    user: ViewerUser,
    session: SessionDep,
    settings: SettingsDep,
    page: LabelQueuePageQuery,
    subject_type: Annotated[
        list[LabelSubjectType] | None, Query(description="only tasks about these subjects")
    ] = None,
    reason: Annotated[list[LabelReason] | None, Query(description="why a task is queued")] = None,
    target_id: Annotated[UUID | None, Query(description="only tasks of this target")] = None,
) -> LabelTaskPage:
    filters = QueueFilters(
        subject_types=subject_type or (), reasons=reason or (), target_id=target_id
    )
    return await label_service.list_label_queue(session, settings, page, filters)


@router.get(
    "/stats",
    response_model=LabelStats,
    summary="Progress toward the first 50 labels and agreement with the machine",
    responses=error_responses(401, 403, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_label_stats(user: ViewerUser, session: SessionDep) -> LabelStats:
    return await label_service.read_label_stats(session)


@router.post(
    "",
    status_code=201,
    response_model=Label,
    summary="Write or replace the caller's label of a subject",
    responses={
        200: {"model": Label, "description": "The label replaced the caller's earlier label"},
        **error_responses(400, 401, 403, 404, 409, 422),
    },
)
async def create_label(
    body: LabelCreate,
    user: MemberUser,
    idempotency: OptionalIdempotencyDep,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    hub: HubDep,
) -> JSONResponse:
    saved = await label_service.save_label(session, user.id, body)
    await label_service.publish_label_events(session_factory, hub, saved.events)
    status_code = 201 if saved.created else 200
    if idempotency is None:
        return JSONResponse(status_code=status_code, content=saved.label.model_dump(mode="json"))
    return await idempotency.respond(saved.label, status_code)


@router.get(
    "",
    response_model=LabelPage,
    summary="Reviewed labels",
    responses=error_responses(401, 403, 422),
)
async def list_labels(
    user: ViewerUser,
    session: SessionDep,
    page: LabelPageQuery,
    subject_type: Annotated[
        list[LabelSubjectType] | None, Query(description="only labels of these subjects")
    ] = None,
    subject_id: Annotated[UUID | None, Query(description="labels of one subject")] = None,
    source: Annotated[list[LabelSource] | None, Query(description="human or judge_weak")] = None,
    labeled_by: Annotated[UUID | None, Query(description="labels written by this user")] = None,
) -> LabelPage:
    filters = LabelFilters(
        subject_types=subject_type or (),
        subject_id=subject_id,
        sources=source or (),
        labeled_by=labeled_by,
    )
    return await label_service.list_labels(session, page, filters)


@router.delete(
    "/{label_id}",
    status_code=204,
    response_class=Response,
    summary="Undo the caller's own human label",
    responses=error_responses(401, 403, 404, 422),
)
async def delete_label(
    label_id: UUID,
    user: MemberUser,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    hub: HubDep,
) -> Response:
    events = await label_service.delete_own_label(session, user.id, label_id)
    await label_service.publish_label_events(session_factory, hub, events)
    return Response(status_code=204)
