from typing import Annotated

from fastapi import APIRouter, Depends, Query

from tessa_api.deps import SessionDep, ViewerUser
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import PromptTemplateName
from tessa_api.schemas.prompts import PromptTemplate, PromptTemplatePage
from tessa_api.services import prompt_issues
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query

router = APIRouter(tags=["prompt-templates"])

TEMPLATE_SORT_KEYS = ("name", "version", "created_at")
TemplatePageQuery = Annotated[PageQuery, Depends(page_query(TEMPLATE_SORT_KEYS, "name,-version"))]


@router.get(
    "/prompt-templates",
    response_model=PromptTemplatePage,
    summary="Prompt Studio list of templates and versions",
    responses=error_responses(401, 403, 422),
)
async def list_prompt_templates(
    user: ViewerUser, session: SessionDep, page: TemplatePageQuery
) -> PromptTemplatePage:
    return await prompt_issues.list_templates(session, page)


@router.get(
    "/prompt-templates/{name}",
    response_model=PromptTemplate,
    summary="One template, the current version unless version is given",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_prompt_template(
    name: PromptTemplateName,
    user: ViewerUser,
    session: SessionDep,
    version: Annotated[int | None, Query(ge=1)] = None,
) -> PromptTemplate:
    return await prompt_issues.read_template(session, name, version)
