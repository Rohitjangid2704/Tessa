from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
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
from tessa_api.schemas.enums import FindingClass, FindingStatus, Severity
from tessa_api.schemas.explanations import Explanation, ExplanationCreate, ExplanationPage
from tessa_api.schemas.findings import (
    Finding,
    FindingOccurrencePage,
    FindingPage,
    FindingRepro,
    FindingUpdate,
    PromoteFindingCreate,
)
from tessa_api.schemas.scenarios import Scenario
from tessa_api.services.artifacts import ArtifactSignerDep
from tessa_api.services.coverage_events import publish_coverage_events
from tessa_api.services.dashboard_events import publish_dashboard_invalidate
from tessa_api.services.findings import explanations as explanation_service
from tessa_api.services.findings import lifecycle, promote, queries, repro
from tessa_api.services.findings.events import publish_event, publish_updated
from tessa_api.services.findings.queries import FindingFilters
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query
from tessa_api.streams.dependencies import HubDep

router = APIRouter(tags=["findings"])

DASHBOARD_FINDING_FIELDS = frozenset({"status", "severity"})
FINDING_SORT_KEYS = ("last_seen_at", "severity", "first_seen_at", "occurrence_count")
OCCURRENCE_SORT_KEYS = ("seen_at",)
EXPLANATION_SORT_KEYS = ("created_at",)
FindingPageQuery = Annotated[PageQuery, Depends(page_query(FINDING_SORT_KEYS, "-last_seen_at"))]
OccurrencePageQuery = Annotated[PageQuery, Depends(page_query(OCCURRENCE_SORT_KEYS, "-seen_at"))]
ExplanationPageQuery = Annotated[
    PageQuery, Depends(page_query(EXPLANATION_SORT_KEYS, "-created_at"))
]


@router.get(
    "/findings",
    response_model=FindingPage,
    summary="Findings for the triage board and its filters",
    responses=error_responses(401, 403, 422),
)
async def list_findings(
    user: ViewerUser,
    session: SessionDep,
    page: FindingPageQuery,
    target_id: Annotated[UUID | None, Query(description="only findings of this target")] = None,
    status: Annotated[list[FindingStatus] | None, Query()] = None,
    severity: Annotated[list[Severity] | None, Query()] = None,
    class_: Annotated[list[FindingClass] | None, Query(alias="class")] = None,
    invariant_id: Annotated[list[str] | None, Query()] = None,
    run_id: Annotated[UUID | None, Query(description="findings seen in this run")] = None,
    scenario_id: Annotated[UUID | None, Query()] = None,
    fingerprint: Annotated[str | None, Query(max_length=200)] = None,
    q: Annotated[str | None, Query(max_length=200, description="text search")] = None,
) -> FindingPage:
    filters = FindingFilters(
        target_id=target_id,
        statuses=status or (),
        severities=severity or (),
        classes=class_ or (),
        invariant_ids=invariant_id or (),
        run_id=run_id,
        scenario_id=scenario_id,
        fingerprint=fingerprint,
        query=q,
    )
    return await queries.list_findings(session, page, filters)


@router.get(
    "/findings/{finding_id}",
    response_model=Finding,
    summary="One finding with its latest explanation",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_finding(finding_id: UUID, user: ViewerUser, session: SessionDep) -> Finding:
    return await queries.read_finding(session, finding_id)


@router.patch(
    "/findings/{finding_id}",
    response_model=Finding,
    summary="Move a finding, set severity, link a ticket or record a known gap",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def update_finding(
    finding_id: UUID, body: FindingUpdate, user: MemberUser, session: SessionDep, hub: HubDep
) -> Finding:
    updated = await lifecycle.update_finding(session, finding_id, body)
    publish_updated(hub, finding_id, updated.changes)
    if DASHBOARD_FINDING_FIELDS & updated.changes.keys():
        publish_dashboard_invalidate(hub)
    return await queries.to_finding(session, updated.row)


@router.get(
    "/findings/{finding_id}/occurrences",
    response_model=FindingOccurrencePage,
    summary="Occurrences of a finding across runs",
    responses=error_responses(401, 403, 404, 422),
)
async def list_occurrences(
    finding_id: UUID, user: ViewerUser, session: SessionDep, page: OccurrencePageQuery
) -> FindingOccurrencePage:
    return await queries.list_occurrences(session, finding_id, page)


@router.get(
    "/findings/{finding_id}/repro",
    response_model=FindingRepro,
    summary="Repro bundle of a finding with signed screencast links",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_repro(
    finding_id: UUID, user: ViewerUser, session: SessionDep, signer: ArtifactSignerDep
) -> FindingRepro:
    return await repro.read_repro(session, signer, finding_id)


@router.post(
    "/findings/{finding_id}/explanations",
    status_code=201,
    response_model=Explanation,
    summary="Paste back the explanation Claude Code produced",
    responses=error_responses(400, 401, 403, 404, 422),
)
async def create_explanation(
    finding_id: UUID,
    body: ExplanationCreate,
    user: MemberUser,
    session: SessionDep,
    settings: SettingsDep,
    idempotency: OptionalIdempotencyDep,
    hub: HubDep,
) -> Explanation | JSONResponse:
    created = await explanation_service.create_explanation(
        session, user.id, finding_id, body, settings.explanation_max_chars
    )
    publish_updated(hub, finding_id, {"explanation_added": (None, str(created.id))})
    if idempotency is None:
        return created
    return await idempotency.respond(created, 201)


@router.get(
    "/findings/{finding_id}/explanations",
    response_model=ExplanationPage,
    summary="Explanation history of a finding",
    responses=error_responses(401, 403, 404, 422),
)
async def list_explanations(
    finding_id: UUID, user: ViewerUser, session: SessionDep, page: ExplanationPageQuery
) -> ExplanationPage:
    return await explanation_service.list_explanations(session, finding_id, page)


@router.post(
    "/findings/{finding_id}/promote",
    status_code=201,
    response_model=Scenario,
    summary="Promote a finding to a scenario that waits in review",
    responses=error_responses(400, 401, 403, 404, 409, 422),
)
async def promote_finding(
    finding_id: UUID,
    body: PromoteFindingCreate,
    user: MemberUser,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    hub: HubDep,
    idempotency: OptionalIdempotencyDep,
) -> Scenario | JSONResponse:
    promoted = await promote.promote_finding(session, user.id, finding_id, body)
    await publish_coverage_events(session_factory, hub, promoted.events)
    publish_event(hub, promoted.finding_event)
    if idempotency is None:
        return promoted.scenario
    return await idempotency.respond(promoted.scenario, 201)
