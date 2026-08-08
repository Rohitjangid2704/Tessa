from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from tessa_api.deps import (
    IdempotencyDep,
    MemberUser,
    SessionDep,
    SettingsDep,
    ViewerUser,
)
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import OracleApproval
from tessa_api.schemas.oracles import (
    OracleApprovalSet,
    OracleResult,
    OracleResultPage,
    OracleRunCreate,
    OracleTemplate,
    OracleTemplatePage,
)
from tessa_api.services import oracles
from tessa_api.services.oracles import OracleTemplateFilters
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query
from tessa_api.temporal_client import TemporalDep

router = APIRouter(tags=["oracles"])

ORACLE_TEMPLATE_SORT_KEYS = ("name", "approval")
ORACLE_RESULT_SORT_KEYS = ("created_at",)
OracleTemplatePageQuery = Annotated[
    PageQuery, Depends(page_query(ORACLE_TEMPLATE_SORT_KEYS, "name"))
]
OracleResultPageQuery = Annotated[
    PageQuery, Depends(page_query(ORACLE_RESULT_SORT_KEYS, "-created_at"))
]


@router.get(
    "/oracle-templates",
    response_model=OracleTemplatePage,
    summary="Oracle templates from the bundles of a target",
    responses=error_responses(401, 403, 404, 422),
)
async def list_oracle_templates(
    user: ViewerUser,
    session: SessionDep,
    page: OracleTemplatePageQuery,
    target_id: Annotated[
        UUID | None,
        Query(description="templates of the latest valid bundle of this target"),
    ] = None,
    bundle_id: Annotated[UUID | None, Query(description="only templates of this bundle")] = None,
    feature_id: Annotated[
        list[str] | None, Query(description="templates that compute these features")
    ] = None,
    approval: Annotated[list[OracleApproval] | None, Query(description="review state")] = None,
) -> OracleTemplatePage:
    filters = OracleTemplateFilters(
        target_id=target_id,
        bundle_id=bundle_id,
        feature_ids=feature_id or (),
        approvals=approval or (),
    )
    return await oracles.list_oracle_templates(session, page, filters)


@router.get(
    "/oracle-templates/{oracle_template_id}",
    response_model=OracleTemplate,
    summary="Source, parameter schema and sentence template of one oracle",
    responses=error_responses(401, 403, 404),
    dependencies=[UnknownQueryRejected],
)
async def read_oracle_template(
    oracle_template_id: UUID, user: ViewerUser, session: SessionDep
) -> OracleTemplate:
    return await oracles.read_oracle_template(session, oracle_template_id)


@router.post(
    "/oracle-templates/{oracle_template_id}/runs",
    status_code=202,
    response_model=OracleResult,
    summary="Run one oracle with parameters; poll the result until it is no longer pending",
    responses=error_responses(400, 401, 403, 404, 409, 422, 503),
)
async def run_oracle_template(
    oracle_template_id: UUID,
    body: OracleRunCreate,
    user: MemberUser,
    idempotency: IdempotencyDep,
    session: SessionDep,
    settings: SettingsDep,
    temporal: TemporalDep,
) -> JSONResponse:
    result = await oracles.start_oracle_run(
        session, temporal, settings.oracle_max_rows, oracle_template_id, body
    )
    return await idempotency.respond(result, 202)


@router.get(
    "/oracle-templates/{oracle_template_id}/results",
    response_model=OracleResultPage,
    summary="History of the runs of one oracle, newest first",
    responses=error_responses(401, 403, 404, 422),
)
async def list_oracle_results(
    oracle_template_id: UUID,
    user: ViewerUser,
    session: SessionDep,
    settings: SettingsDep,
    page: OracleResultPageQuery,
) -> OracleResultPage:
    return await oracles.list_oracle_results(
        session, oracle_template_id, page, settings.oracle_max_rows
    )


@router.put(
    "/oracle-templates/{oracle_template_id}/approval",
    response_model=OracleTemplate,
    summary="Approve or reject an oracle after viewing one of its results",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def set_oracle_approval(
    oracle_template_id: UUID,
    body: OracleApprovalSet,
    user: MemberUser,
    session: SessionDep,
) -> OracleTemplate:
    return await oracles.set_oracle_approval(session, oracle_template_id, body)


@router.get(
    "/oracle-results/{oracle_result_id}",
    response_model=OracleResult,
    summary="Rows and rendered sentence of one oracle run",
    responses=error_responses(401, 403, 404),
    dependencies=[UnknownQueryRejected],
)
async def read_oracle_result(
    oracle_result_id: UUID, user: ViewerUser, session: SessionDep, settings: SettingsDep
) -> OracleResult:
    return await oracles.read_oracle_result(session, oracle_result_id, settings.oracle_max_rows)
