from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from tessa_api.deps import (
    MemberUser,
    OptionalIdempotencyDep,
    SessionDep,
    SettingsDep,
    ViewerUser,
)
from tessa_api.errors import error_responses
from tessa_api.schemas.plans import Plan
from tessa_api.schemas.proposals import (
    Proposal,
    ProposalItem,
    ProposalItemUpdate,
    ProposalPlanCreate,
    ProposalPut,
)
from tessa_api.services import proposals as proposal_service
from tessa_api.services.vault import VaultDep
from tessa_api.streams.dependencies import HubDep

router = APIRouter(tags=["proposals"])


@router.get(
    "/targets/{target_id}/proposal",
    response_model=Proposal,
    summary="The current test proposal of a target, with the cells each item maps to; 404 when "
    "the target has none",
    responses=error_responses(401, 403, 404),
)
async def read_proposal(
    target_id: UUID, user: ViewerUser, session: SessionDep, settings: SettingsDep
) -> Proposal:
    return await proposal_service.read_proposal(session, settings, target_id, user.id)


@router.put(
    "/targets/{target_id}/proposal",
    response_model=Proposal,
    summary="Store a test proposal from the content of tessa/proposal.yaml; ticks, notes and "
    "authored scenarios carry over to items that keep their key",
    responses=error_responses(401, 403, 404, 409, 413, 422),
)
async def put_proposal(
    target_id: UUID,
    body: ProposalPut,
    user: MemberUser,
    session: SessionDep,
    settings: SettingsDep,
    hub: HubDep,
) -> Proposal:
    return await proposal_service.put_proposal(session, settings, hub, user.id, target_id, body)


@router.patch(
    "/proposal-items/{item_id}",
    response_model=ProposalItem,
    summary="Tick, decline or reset an item of the current proposal; authored and covered are "
    "set by Tessa and cannot be sent",
    responses=error_responses(401, 403, 404, 409, 422),
)
async def update_proposal_item(
    item_id: UUID,
    body: ProposalItemUpdate,
    user: MemberUser,
    session: SessionDep,
    settings: SettingsDep,
    hub: HubDep,
) -> ProposalItem:
    return await proposal_service.update_item(session, settings, hub, user.id, item_id, body)


@router.post(
    "/targets/{target_id}/proposal/plan",
    status_code=201,
    response_model=Plan,
    summary="Save a plan that covers the selected items of the current proposal, or the items "
    "named in item_ids",
    responses=error_responses(400, 401, 403, 404, 409, 422),
)
async def plan_from_proposal(
    target_id: UUID,
    body: ProposalPlanCreate,
    user: MemberUser,
    session: SessionDep,
    settings: SettingsDep,
    vault: VaultDep,
    idempotency: OptionalIdempotencyDep,
) -> Plan | JSONResponse:
    plan = await proposal_service.plan_from_proposal(
        session, settings, vault, user.id, target_id, body
    )
    if idempotency is None:
        return plan
    return await idempotency.respond(plan, 201)
