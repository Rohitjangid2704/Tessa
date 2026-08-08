import asyncio
import logging
from enum import StrEnum

from fastapi import WebSocket
from pydantic import ValidationError
from sqlalchemy.exc import InterfaceError, OperationalError

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.events import FrameIngestMessage, TileFramePayload
from tessa_api.streams.broker import FrameSource
from tessa_api.streams.hub import Hub
from tessa_api.streams.log import find_active_browser_session_run
from tessa_api.streams.ws import CLOSE_FAILURES, CloseCode, close_quietly, raw_payload

logger = logging.getLogger("tessa_api.frames")

DATABASE_ERRORS = (ConnectionError, OperationalError, InterfaceError)


class IngestOutcome(StrEnum):
    disconnected = "disconnected"
    bad_frame = "bad_frame"
    shutdown = "shutdown"


async def route_frame(hub: Hub, session_factory: SessionFactory, payload: TileFramePayload) -> None:
    broker = hub.tiles
    if broker.publish_frame(payload):
        return
    session_id = payload.browser_session_id
    if broker.recently_unknown(session_id):
        return
    try:
        async with session_factory() as session:
            run_id = await find_active_browser_session_run(session, session_id)
    except DATABASE_ERRORS:
        logger.warning("frame_session_lookup_failed")
        return
    if run_id is None:
        broker.remember_unknown(session_id)
        return
    broker.register_session(session_id, run_id)
    broker.publish_frame(payload)


async def receive_frames(
    websocket: WebSocket, hub: Hub, session_factory: SessionFactory
) -> IngestOutcome:
    while True:
        try:
            message = await websocket.receive()
        except CLOSE_FAILURES:
            return IngestOutcome.disconnected
        if message["type"] == "websocket.disconnect":
            return IngestOutcome.disconnected
        try:
            frame = FrameIngestMessage.model_validate_json(raw_payload(message))
        except ValidationError:
            logger.warning("frame_message_invalid")
            return IngestOutcome.bad_frame
        await route_frame(hub, session_factory, frame.payload)


async def send_demands(websocket: WebSocket, source: FrameSource) -> IngestOutcome:
    while True:
        await source.wake.wait()
        if source.closed:
            return IngestOutcome.shutdown
        try:
            for message in source.take():
                await websocket.send_text(message.model_dump_json())
        except CLOSE_FAILURES:
            return IngestOutcome.disconnected


async def serve_frame_ingest(
    websocket: WebSocket, hub: Hub, session_factory: SessionFactory
) -> None:
    source = hub.tiles.attach_source()
    tasks = {
        asyncio.create_task(receive_frames(websocket, hub, session_factory)),
        asyncio.create_task(send_demands(websocket, source)),
    }
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        hub.tiles.detach_source(source)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    outcomes = {task.result() for task in done}
    if IngestOutcome.bad_frame in outcomes:
        await close_quietly(websocket, CloseCode.bad_client_message, "bad_frame_message")
    elif IngestOutcome.shutdown in outcomes:
        await close_quietly(websocket, CloseCode.going_away, "shutdown")
