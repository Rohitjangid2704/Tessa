from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from tessa_api.deps import AdminUser, SessionDep
from tessa_api.errors import ApiError, error_responses
from tessa_api.schemas.audit import AuditEventPage
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import AuditSubjectType, AuditVia
from tessa_api.services import audit_events
from tessa_api.services.audit_events import AuditFilters
from tessa_api.services.pagination import PageQuery, page_query

router = APIRouter(tags=["audit"])

AUDIT_SORT_KEYS = ("created_at",)
AuditPageQuery = Annotated[PageQuery, Depends(page_query(AUDIT_SORT_KEYS, "-created_at"))]


@router.get(
    "/audit-events",
    response_model=AuditEventPage,
    summary="The audit log, newest first: administration changes and every write made with a "
    "personal token",
    responses=error_responses(401, 403, 422),
)
async def list_audit_events(
    user: AdminUser,
    session: SessionDep,
    page: AuditPageQuery,
    actor_user_id: Annotated[
        UUID | None, Query(description="only changes made by this user")
    ] = None,
    via: Annotated[AuditVia | None, Query(description="how the change reached the API")] = None,
    subject_type: Annotated[
        AuditSubjectType | None, Query(description="only changes to this kind of subject")
    ] = None,
    subject_id: Annotated[UUID | None, Query(description="only changes to this subject")] = None,
    agent_session_id: Annotated[
        UUID | None, Query(description="only changes made during this agent session")
    ] = None,
    since: Annotated[
        datetime | None, Query(description="only changes at or after this moment, with an offset")
    ] = None,
) -> AuditEventPage:
    if since is not None and since.tzinfo is None:
        detail = ErrorDetail(
            loc=["query", "since"],
            code="offset_required",
            message="since must carry a UTC offset, for example 2026-10-08T09:30:00Z",
        )
        raise ApiError(422, "validation_failed", "Request validation failed", [detail])
    filters = AuditFilters(
        actor_user_id=actor_user_id,
        via=via,
        subject_type=subject_type,
        subject_id=subject_id,
        agent_session_id=agent_session_id,
        since=since,
    )
    return await audit_events.list_audit_events(session, page, filters)
