from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from tessa_api.deps import SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import NotificationKind
from tessa_api.schemas.notifications import Notification, NotificationPage
from tessa_api.services import notifications as notification_service
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query

router = APIRouter(tags=["notifications"])

NOTIFICATION_SORT_KEYS = ("created_at",)
NotificationPageQuery = Annotated[
    PageQuery, Depends(page_query(NOTIFICATION_SORT_KEYS, "-created_at"))
]


@router.get(
    "/notifications",
    response_model=NotificationPage,
    summary="Notifications of the caller and the broadcast ones, newest first",
    responses=error_responses(401, 403, 422),
)
async def list_notifications(
    user: ViewerUser,
    session: SessionDep,
    page: NotificationPageQuery,
    unread: Annotated[
        bool | None, Query(description="true lists only unread ones, false only read ones")
    ] = None,
    kind: Annotated[list[NotificationKind] | None, Query()] = None,
) -> NotificationPage:
    return await notification_service.list_notifications(session, user.id, page, unread, kind or ())


@router.post(
    "/notifications/read-all",
    status_code=204,
    response_class=Response,
    summary="Mark every notification of the caller read",
    responses=error_responses(401, 403, 422),
    dependencies=[UnknownQueryRejected],
)
async def mark_all_read(user: ViewerUser, session: SessionDep) -> Response:
    await notification_service.mark_all_read(session, user.id)
    return Response(status_code=204)


@router.post(
    "/notifications/{notification_id}/read",
    response_model=Notification,
    summary="Mark one notification read",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def mark_read(notification_id: UUID, user: ViewerUser, session: SessionDep) -> Notification:
    return await notification_service.mark_read(session, user.id, notification_id)
