from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse, JSONResponse

from tessa_api.deps import (
    IdempotencyDep,
    MemberUser,
    SessionDep,
    SessionFactoryDep,
    SettingsDep,
    ViewerOrServiceUser,
    ViewerUser,
)
from tessa_api.errors import error_responses, json_error_responses, not_found
from tessa_api.schemas.common import RunHandle
from tessa_api.schemas.enums import (
    BrowserSessionStatus,
    InvariantPack,
    RunKind,
    RunScenarioStatus,
    RunStatus,
    VerdictStatus,
)
from tessa_api.schemas.invariants import InvariantResultPage
from tessa_api.schemas.reports import (
    REPORT_HTML_CONTENT_SECURITY_POLICY,
    REPORT_HTML_CONTENT_TYPE_OPTIONS,
    RunReport,
)
from tessa_api.schemas.run_stats import RunDiff, RunStats
from tessa_api.schemas.runs import (
    BrowserSessionList,
    Run,
    RunCreate,
    RunScenarioPage,
    RunSummaryPage,
)
from tessa_api.schemas.streams import RunEventPage
from tessa_api.services import (
    reports,
    run_diff,
    run_invariants,
    run_service,
    run_stats,
    run_views,
)
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query
from tessa_api.services.run_invariants import InvariantResultFilters
from tessa_api.services.run_origin import origin_for_caller
from tessa_api.services.run_views import RunFilters, RunScenarioFilters
from tessa_api.services.storage import storage_from_settings
from tessa_api.services.vault import VaultDep
from tessa_api.streams.dependencies import HubDep
from tessa_api.streams.log import (
    read_events_page,
    read_log_bounds,
    run_row_exists,
    to_run_event,
)
from tessa_api.temporal_client import TemporalDep

router = APIRouter(tags=["runs"])

RUN_SORT_KEYS = ("created_at",)
RUN_SCENARIO_SORT_KEYS = ("created_at", "status", "role", "interface_id")
INVARIANT_RESULT_SORT_KEYS = ("created_at", "invariant_id", "status")
RunPageQuery = Annotated[PageQuery, Depends(page_query(RUN_SORT_KEYS, "-created_at"))]
InvariantResultPageQuery = Annotated[
    PageQuery, Depends(page_query(INVARIANT_RESULT_SORT_KEYS, "created_at"))
]
RunScenarioPageQuery = Annotated[
    PageQuery, Depends(page_query(RUN_SCENARIO_SORT_KEYS, "created_at"))
]


@router.post(
    "",
    status_code=202,
    response_model=RunHandle,
    summary="Run a saved plan, an inline plan or a list of accepted scenarios now; a subset run "
    "skips the synthetic invariant scenarios and the API fuzz family",
    responses=error_responses(400, 401, 403, 404, 409, 422, 503),
)
async def create_run(
    body: RunCreate,
    user: MemberUser,
    idempotency: IdempotencyDep,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
    vault: VaultDep,
    hub: HubDep,
    temporal: TemporalDep,
) -> JSONResponse:
    handle = await run_service.start_run(
        session,
        session_factory,
        hub,
        temporal,
        settings,
        vault,
        user.id,
        body,
        origin_for_caller(),
    )
    return await idempotency.respond(handle, 202)


@router.get(
    "",
    response_model=RunSummaryPage,
    summary="Runs list",
    responses=error_responses(401, 403, 422),
)
async def list_runs(
    user: ViewerUser,
    session: SessionDep,
    page: RunPageQuery,
    target_id: Annotated[UUID | None, Query(description="only runs of this target")] = None,
    status: Annotated[list[RunStatus] | None, Query()] = None,
    kind: Annotated[list[RunKind] | None, Query()] = None,
    plan_id: Annotated[UUID | None, Query()] = None,
    created_after: Annotated[datetime | None, Query(description="ISO 8601 lower bound")] = None,
    created_before: Annotated[datetime | None, Query(description="ISO 8601 upper bound")] = None,
) -> RunSummaryPage:
    filters = RunFilters(
        target_id=target_id,
        statuses=status or (),
        kinds=kind or (),
        plan_id=plan_id,
        created_after=created_after,
        created_before=created_before,
    )
    return await run_views.list_runs(session, page, filters)


@router.get(
    "/{run_id}",
    response_model=Run,
    summary="Run detail",
    responses=error_responses(401, 403, 404),
    dependencies=[UnknownQueryRejected],
)
async def read_run(
    run_id: UUID, caller: ViewerOrServiceUser, session: SessionDep, settings: SettingsDep
) -> Run:
    return await run_views.read_run(session, settings, run_id)


@router.post(
    "/{run_id}/cancel",
    status_code=202,
    response_model=Run,
    summary="Cancel a run",
    responses=error_responses(401, 403, 404, 409, 503),
)
async def cancel_run(
    run_id: UUID,
    user: MemberUser,
    session: SessionDep,
    settings: SettingsDep,
    temporal: TemporalDep,
) -> Run:
    run = await run_service.request_cancel(session, temporal, run_id)
    return run_views.to_run(run, settings, datetime.now(UTC))


@router.get(
    "/{run_id}/scenarios",
    response_model=RunScenarioPage,
    summary="Scenario executions of a run",
    responses=error_responses(401, 403, 404, 422),
)
async def list_run_scenarios(
    run_id: UUID,
    user: ViewerUser,
    session: SessionDep,
    page: RunScenarioPageQuery,
    status: Annotated[list[RunScenarioStatus] | None, Query()] = None,
    verdict: Annotated[list[VerdictStatus] | None, Query()] = None,
    family: Annotated[list[str] | None, Query()] = None,
    role: Annotated[list[str] | None, Query()] = None,
) -> RunScenarioPage:
    filters = RunScenarioFilters(
        statuses=status or (),
        verdicts=verdict or (),
        families=family or (),
        roles=role or (),
    )
    return await run_views.list_run_scenarios(session, run_id, page, filters)


@router.get(
    "/{run_id}/browser-sessions",
    response_model=BrowserSessionList,
    summary="Browser sessions of a run, for the live tile grid",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def list_browser_sessions(
    run_id: UUID,
    user: ViewerUser,
    session: SessionDep,
    status: Annotated[list[BrowserSessionStatus] | None, Query()] = None,
) -> BrowserSessionList:
    return await run_views.list_browser_sessions(session, run_id, status or ())


@router.get(
    "/{run_id}/stats",
    response_model=RunStats,
    summary="pass^k, invariant summary, latency and cost percentiles of a run",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_run_stats(run_id: UUID, user: ViewerUser, session: SessionDep) -> RunStats:
    return await run_stats.read_run_stats(session, run_id)


@router.get(
    "/{run_id}/invariants",
    response_model=InvariantResultPage,
    summary="Invariant results of a run",
    responses=error_responses(401, 403, 404, 422),
)
async def list_run_invariants(
    run_id: UUID,
    user: ViewerUser,
    session: SessionDep,
    page: InvariantResultPageQuery,
    status: Annotated[list[VerdictStatus] | None, Query()] = None,
    invariant_id: Annotated[list[str] | None, Query()] = None,
    pack: Annotated[list[InvariantPack] | None, Query()] = None,
) -> InvariantResultPage:
    filters = InvariantResultFilters(
        statuses=status or (), invariant_ids=invariant_id or (), packs=pack or ()
    )
    return await run_invariants.list_run_invariants(session, run_id, page, filters)


@router.get(
    "/{run_id}/diff",
    response_model=RunDiff,
    summary="Verdict changes against an earlier run",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_run_diff(
    run_id: UUID,
    user: ViewerUser,
    session: SessionDep,
    against: Annotated[
        UUID | None,
        Query(description="run to compare with; default is the previous completed run of the plan"),
    ] = None,
) -> RunDiff:
    return await run_diff.build_run_diff(session, run_id, against)


@router.get(
    "/{run_id}/report",
    response_model=RunReport,
    summary="JSON report of a run: stats, findings, diff and the frozen configuration",
    responses=error_responses(401, 403, 404, 409, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_run_report(
    run_id: UUID, user: ViewerUser, session: SessionDep, settings: SettingsDep
) -> RunReport:
    rendered = await reports.load_report(
        session, storage_from_settings(settings), settings.report_base_url, run_id
    )
    return rendered.report


@router.get(
    "/{run_id}/report.html",
    response_class=HTMLResponse,
    summary="Self-contained HTML report of a run; embeds text of the system under test, so it is "
    "served sandboxed",
    responses={
        200: {
            "description": "HTML document served with Content-Security-Policy sandbox",
            "content": {"text/html": {"schema": {"type": "string"}}},
            "headers": {
                "Content-Security-Policy": {
                    "description": REPORT_HTML_CONTENT_SECURITY_POLICY,
                    "schema": {"type": "string"},
                },
                "X-Content-Type-Options": {
                    "description": REPORT_HTML_CONTENT_TYPE_OPTIONS,
                    "schema": {"type": "string"},
                },
                "Content-Disposition": {
                    "description": 'inline; filename="run-{run_id}.html"',
                    "schema": {"type": "string"},
                },
            },
        },
        **json_error_responses(401, 403, 404, 409, 422),
    },
    dependencies=[UnknownQueryRejected],
)
async def read_run_report_html(
    run_id: UUID, user: ViewerUser, session: SessionDep, settings: SettingsDep
) -> HTMLResponse:
    rendered = await reports.load_report(
        session, storage_from_settings(settings), settings.report_base_url, run_id
    )
    return HTMLResponse(rendered.html, headers=reports.report_html_headers(run_id))


@router.get(
    "/{run_id}/events",
    response_model=RunEventPage,
    summary="Persisted event log of a run",
    responses=error_responses(401, 403, 404, 422),
)
async def list_run_events(
    run_id: UUID,
    user: ViewerUser,
    session: SessionDep,
    after_seq: Annotated[int | None, Query(ge=0)] = None,
    before_seq: Annotated[int | None, Query(ge=1)] = None,
    order: Literal["asc", "desc"] = "asc",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    type: Annotated[list[str] | None, Query()] = None,
) -> RunEventPage:
    bounds = await read_log_bounds(session, run_id)
    if bounds.head_seq == 0 and not await run_row_exists(session, run_id):
        raise not_found("Run not found")
    rows, has_more = await read_events_page(
        session, run_id, after_seq, before_seq, order, limit, type
    )
    return RunEventPage(
        items=[to_run_event(row) for row in rows], head_seq=bounds.head_seq, has_more=has_more
    )
