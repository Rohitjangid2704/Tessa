from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from tessa_api.deps import MemberUser, SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.agent_sessions import (
    AgentSession,
    AgentSessionCreate,
    AgentSessionPage,
    AgentSessionUpdate,
)
from tessa_api.services import agent_sessions as session_service
from tessa_api.services.pagination import PageQuery, page_query
from tessa_api.streams.dependencies import HubDep

router = APIRouter(tags=["agent-sessions"])

AGENT_SESSION_SORT_KEYS = ("started_at",)
AgentSessionPageQuery = Annotated[
    PageQuery, Depends(page_query(AGENT_SESSION_SORT_KEYS, "-started_at"))
]


@router.post(
    "/agent-sessions",
    status_code=201,
    response_model=AgentSession,
    summary="A Claude Code session announces itself; a second call with the id of a session "
    "that is still open returns that session with status 200",
    responses={
        200: {"model": AgentSession, "description": "The session was already open"},
        **error_responses(401, 403, 404, 422),
    },
)
async def create_agent_session(
    body: AgentSessionCreate, user: MemberUser, session: SessionDep, hub: HubDep
) -> JSONResponse:
    view, row, created = await session_service.create_session(session, user, body)
    session_service.publish_changed(hub, row)
    return JSONResponse(status_code=201 if created else 200, content=view.model_dump(mode="json"))


@router.get(
    "/agent-sessions",
    response_model=AgentSessionPage,
    summary="Claude Code sessions that talked to Tessa, newest first",
    responses=error_responses(401, 403, 422),
)
async def list_agent_sessions(
    user: ViewerUser,
    session: SessionDep,
    page: AgentSessionPageQuery,
    target_id: Annotated[UUID | None, Query(description="only sessions on this target")] = None,
    user_id: Annotated[UUID | None, Query(description="only sessions of this user")] = None,
    active: Annotated[
        bool | None, Query(description="true only open sessions, false only ended or stale")
    ] = None,
) -> AgentSessionPage:
    return await session_service.list_sessions(session, page, target_id, user_id, active)


@router.patch(
    "/agent-sessions/{agent_session_id}",
    response_model=AgentSession,
    summary="Move the session to another target, end it or leave a summary; only the owner "
    "may change a session",
    responses=error_responses(401, 403, 404, 422),
)
async def update_agent_session(
    agent_session_id: UUID,
    body: AgentSessionUpdate,
    user: MemberUser,
    session: SessionDep,
    hub: HubDep,
) -> AgentSession:
    view, row = await session_service.update_session(session, user, agent_session_id, body)
    session_service.publish_changed(hub, row)
    return view
