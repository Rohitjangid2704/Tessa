from fastapi import APIRouter, WebSocket

from tessa_api.auth.service_key import service_key_matches
from tessa_api.db.session import SessionFactory
from tessa_api.settings import Settings
from tessa_api.streams.frames import serve_frame_ingest
from tessa_api.streams.hub import Hub
from tessa_api.streams.ws import CloseCode, close_quietly

router = APIRouter(tags=["internal"], include_in_schema=False)


@router.websocket("/internal/v1/frames")
async def frame_ingest(websocket: WebSocket) -> None:
    settings: Settings = websocket.app.state.settings
    session_factory: SessionFactory = websocket.app.state.session_factory
    hub: Hub = websocket.app.state.hub
    await websocket.accept()
    if not service_key_matches(websocket.headers.get("x-service-key"), settings):
        await close_quietly(websocket, CloseCode.unauthenticated, "invalid_service_key")
        return
    await serve_frame_ingest(websocket, hub, session_factory)
