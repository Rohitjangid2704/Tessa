from fastapi import APIRouter

from tessa_api.deps import SessionDep, SettingsDep, ViewerUser
from tessa_api.errors import error_responses, not_found
from tessa_api.schemas.streams import WsTicket, WsTicketCreate
from tessa_api.services.tickets import issue_ticket
from tessa_api.streams.log import run_is_known

router = APIRouter(tags=["ws_tickets"])


@router.post(
    "",
    response_model=WsTicket,
    summary="Mint a single-use WebSocket ticket scoped to one run",
    responses=error_responses(401, 403, 404, 422),
)
async def create_ws_ticket(
    body: WsTicketCreate, user: ViewerUser, session: SessionDep, settings: SettingsDep
) -> WsTicket:
    if not await run_is_known(session, body.run_id):
        raise not_found("Run not found")
    return issue_ticket(settings, user.id, body.run_id)
