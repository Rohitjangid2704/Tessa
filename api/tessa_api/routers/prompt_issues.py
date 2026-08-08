from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from tessa_api.deps import (
    MemberUser,
    OptionalIdempotencyDep,
    SessionDep,
    SettingsDep,
    ViewerUser,
)
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import PromptTemplateName
from tessa_api.schemas.prompts import PromptIssue, PromptIssueCreate, PromptIssuePage
from tessa_api.services import prompt_issues
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query

router = APIRouter(tags=["prompt-issues"])

ISSUE_SORT_KEYS = ("issued_at",)
IssuePageQuery = Annotated[PageQuery, Depends(page_query(ISSUE_SORT_KEYS, "-issued_at"))]


@router.post(
    "/targets/{target_id}/prompt-issues",
    status_code=201,
    response_model=PromptIssue,
    summary="Render and store a prompt for a target",
    responses=error_responses(400, 401, 403, 404, 409, 422),
)
async def create_prompt_issue(
    target_id: UUID,
    body: PromptIssueCreate,
    user: MemberUser,
    session: SessionDep,
    settings: SettingsDep,
    idempotency: OptionalIdempotencyDep,
) -> PromptIssue | JSONResponse:
    issued = await prompt_issues.issue_prompt(session, settings, user, target_id, body.root)
    if idempotency is None:
        return issued
    return await idempotency.respond(issued, 201)


@router.get(
    "/targets/{target_id}/prompt-issues",
    response_model=PromptIssuePage,
    summary="Prompt history of a target",
    responses=error_responses(401, 403, 404, 422),
)
async def list_prompt_issues(
    target_id: UUID,
    user: ViewerUser,
    session: SessionDep,
    page: IssuePageQuery,
    template_name: Annotated[list[PromptTemplateName] | None, Query()] = None,
) -> PromptIssuePage:
    return await prompt_issues.list_issues(session, target_id, page, template_name)


@router.get(
    "/prompt-issues/{prompt_issue_id}",
    response_model=PromptIssue,
    summary="Re-open an issued prompt",
    responses=error_responses(401, 403, 404),
    dependencies=[UnknownQueryRejected],
)
async def read_prompt_issue(
    prompt_issue_id: UUID, user: ViewerUser, session: SessionDep
) -> PromptIssue:
    return await prompt_issues.read_issue(session, prompt_issue_id)
