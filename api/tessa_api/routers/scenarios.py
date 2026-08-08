from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.session import SessionFactory
from tessa_api.deps import (
    MemberUser,
    OptionalIdempotencyDep,
    SessionDep,
    SessionFactoryDep,
    SettingsDep,
    ViewerUser,
)
from tessa_api.errors import error_responses
from tessa_api.schemas.enums import CoverageUpdateReason, ScenarioOrigin, ScenarioStatus
from tessa_api.schemas.scenarios import (
    Scenario,
    ScenarioCreate,
    ScenarioPatch,
    ScenarioProvenance,
    ScenarioReviewCreate,
    ScenarioSummaryPage,
    ScenarioUpdate,
    ScenarioValidateRequest,
    ScenarioValidation,
    ScenarioVersionPage,
)
from tessa_api.services import scenario_library, scenario_lifecycle
from tessa_api.services.coverage_events import publish_coverage_events
from tessa_api.services.pagination import PageQuery, UnknownQueryRejected, page_query
from tessa_api.services.scenario_library import ScenarioFilters, to_scenario
from tessa_api.services.scenario_lifecycle import ScenarioWrite, lifecycle_events
from tessa_api.streams.dependencies import HubDep
from tessa_api.streams.hub import Hub

router = APIRouter(tags=["scenarios"])

SCENARIO_SORT_KEYS = ("created_at", "updated_at", "title")
VERSION_SORT_KEYS = ("version",)
ScenarioPageQuery = Annotated[PageQuery, Depends(page_query(SCENARIO_SORT_KEYS, "-created_at"))]
ScenarioVersionPageQuery = Annotated[PageQuery, Depends(page_query(VERSION_SORT_KEYS, "-version"))]


async def commit_and_announce(
    session: AsyncSession, session_factory: SessionFactory, hub: Hub, write: ScenarioWrite
) -> Scenario:
    await session.commit()
    await publish_coverage_events(
        session_factory, hub, lifecycle_events(write, CoverageUpdateReason.review)
    )
    return to_scenario(write.row)


@router.get(
    "/scenarios",
    response_model=ScenarioSummaryPage,
    summary="Scenario library and review queue",
    responses=error_responses(401, 403, 422),
)
async def list_scenarios(
    user: ViewerUser,
    session: SessionDep,
    page: ScenarioPageQuery,
    target_id: Annotated[UUID | None, Query(description="only scenarios of this target")] = None,
    status: Annotated[list[ScenarioStatus] | None, Query()] = None,
    origin: Annotated[list[ScenarioOrigin] | None, Query()] = None,
    family: Annotated[list[str] | None, Query()] = None,
    feature_id: Annotated[list[str] | None, Query()] = None,
    cell_id: Annotated[UUID | None, Query(description="scenarios of one coverage cell")] = None,
    plan_id: Annotated[UUID | None, Query(description="scenarios covering a plan")] = None,
    q: Annotated[str | None, Query(max_length=200, description="text search")] = None,
    include_synthetic: Annotated[
        bool, Query(description="include scenarios Tessa generates itself")
    ] = False,
) -> ScenarioSummaryPage:
    filters = ScenarioFilters(
        target_id=target_id,
        statuses=status or (),
        origins=origin or (),
        families=family or (),
        feature_ids=feature_id or (),
        cell_id=cell_id,
        plan_id=plan_id,
        query=q,
        include_synthetic=include_synthetic,
    )
    return await scenario_library.list_scenarios(session, page, filters)


@router.post(
    "/scenarios/validate",
    response_model=ScenarioValidation,
    summary="Validate scenario YAML without saving it",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def validate_scenario(
    body: ScenarioValidateRequest, user: ViewerUser, session: SessionDep
) -> ScenarioValidation:
    checked = await scenario_lifecycle.check_for_target(session, body.target_id, body.yaml)
    return checked.check.validation


@router.get(
    "/scenarios/{scenario_id}",
    response_model=Scenario,
    summary="One scenario with its YAML, always the current version",
    responses=error_responses(401, 403, 404),
    dependencies=[UnknownQueryRejected],
)
async def read_scenario(scenario_id: UUID, user: ViewerUser, session: SessionDep) -> Scenario:
    return await scenario_library.read_scenario(session, scenario_id)


@router.post(
    "/scenarios",
    status_code=201,
    response_model=Scenario,
    summary="Create a scenario from YAML",
    responses=error_responses(400, 401, 403, 404, 409, 422),
)
async def create_scenario(
    body: ScenarioCreate,
    user: MemberUser,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
    hub: HubDep,
    idempotency: OptionalIdempotencyDep,
) -> Scenario | JSONResponse:
    write = await scenario_lifecycle.create_from_yaml(session, settings, user.id, body)
    scenario = await commit_and_announce(session, session_factory, hub, write)
    if idempotency is None:
        return scenario
    return await idempotency.respond(scenario, 201)


@router.put(
    "/scenarios/{scenario_id}",
    response_model=Scenario,
    summary="Save an edit as a new scenario version",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def update_scenario(
    scenario_id: UUID,
    body: ScenarioUpdate,
    user: MemberUser,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
    hub: HubDep,
) -> Scenario:
    write = await scenario_lifecycle.update_scenario(
        session, settings, user.id, scenario_id, body.yaml, body.base_version
    )
    return await commit_and_announce(session, session_factory, hub, write)


@router.patch(
    "/scenarios/{scenario_id}",
    response_model=Scenario,
    summary="Retire, quarantine or accept a scenario",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def patch_scenario(
    scenario_id: UUID,
    body: ScenarioPatch,
    user: MemberUser,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    hub: HubDep,
) -> Scenario:
    write = await scenario_lifecycle.patch_scenario_status(session, scenario_id, body.status)
    return await commit_and_announce(session, session_factory, hub, write)


@router.post(
    "/scenarios/{scenario_id}/review",
    response_model=Scenario,
    summary="Accept or reject a scenario in the review queue",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def review_scenario(
    scenario_id: UUID,
    body: ScenarioReviewCreate,
    user: MemberUser,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    hub: HubDep,
) -> Scenario:
    write = await scenario_lifecycle.review_scenario(
        session, user.id, scenario_id, body.decision, body.note
    )
    return await commit_and_announce(session, session_factory, hub, write)


@router.get(
    "/scenarios/{scenario_id}/provenance",
    response_model=ScenarioProvenance,
    summary="Where a scenario came from",
    responses=error_responses(401, 403, 404, 422),
    dependencies=[UnknownQueryRejected],
)
async def read_scenario_provenance(
    scenario_id: UUID, user: ViewerUser, session: SessionDep
) -> ScenarioProvenance:
    return await scenario_lifecycle.read_provenance(session, scenario_id)


@router.get(
    "/scenarios/{scenario_id}/versions",
    response_model=ScenarioVersionPage,
    summary="Version history of a scenario with the YAML of every version",
    responses=error_responses(401, 403, 404, 422),
)
async def list_scenario_versions(
    scenario_id: UUID, user: ViewerUser, session: SessionDep, page: ScenarioVersionPageQuery
) -> ScenarioVersionPage:
    return await scenario_lifecycle.list_versions(session, scenario_id, page)
