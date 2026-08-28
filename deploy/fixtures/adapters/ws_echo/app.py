import json
import os

from fastapi import FastAPI, WebSocket

from fixtures.adapters.ws_echo.config import (
    DEFAULT_TOKEN,
    MAX_MESSAGE_CHARS,
    MESSAGE_TOO_BIG,
    NORMAL_CLOSURE,
    POLICY_VIOLATION,
    PROTOCOL_VERSION,
    ROOM_STATUS,
    SERVER_NAME,
    TOKEN_ENV,
    UNSUPPORTED_DATA,
)

POISON_TEXT = "poison"
POISON_TYPE = "poison"


def presented_token(websocket: WebSocket) -> str | None:
    scheme, _, value = websocket.headers.get("authorization", "").partition(" ")
    if scheme.lower() == "bearer" and value.strip():
        return value.strip()
    return websocket.query_params.get("token")


def parse_message(text: str) -> object:
    try:
        parsed: object = json.loads(text)
    except ValueError:
        return text
    return parsed


def message_type(message: object) -> str | None:
    if isinstance(message, dict):
        declared = message.get("type")
        return declared if isinstance(declared, str) else None
    return None


def is_poisoned(text: str, message: object) -> bool:
    return text.strip() == POISON_TEXT or message_type(message) == POISON_TYPE


async def reply_to_subscribe(websocket: WebSocket, message: object, sequence: int) -> None:
    room = message.get("room") if isinstance(message, dict) else None
    if not isinstance(room, str) or not room:
        await websocket.send_json({"type": "error", "code": "room_required", "seq": sequence})
        return
    await websocket.send_json({"type": "subscribed", "room": room, "seq": sequence})
    await websocket.send_json(
        {"type": "room_update", "room": room, "status": ROOM_STATUS.get(room, "unknown")}
    )


async def respond(websocket: WebSocket, text: str, sequence: int) -> bool:
    message = parse_message(text)
    if is_poisoned(text, message):
        await websocket.close(code=POLICY_VIOLATION, reason="poisoned message")
        return False
    declared = message_type(message)
    if declared == "ping":
        await websocket.send_json({"type": "pong", "seq": sequence})
    elif declared == "subscribe":
        await reply_to_subscribe(websocket, message, sequence)
    elif declared == "close":
        await websocket.send_json({"type": "bye", "seq": sequence})
        await websocket.close(code=NORMAL_CLOSURE, reason="bye")
        return False
    else:
        await websocket.send_json({"type": "echo", "seq": sequence, "data": message})
    return True


async def converse(websocket: WebSocket, expected_token: str) -> None:
    await websocket.accept()
    if presented_token(websocket) != expected_token:
        await websocket.close(code=POLICY_VIOLATION, reason="unauthorized")
        return
    await websocket.send_json({"type": "hello", "server": SERVER_NAME, "version": PROTOCOL_VERSION})
    sequence = 0
    while True:
        frame = await websocket.receive()
        if frame["type"] == "websocket.disconnect":
            return
        text = frame.get("text")
        if text is None:
            await websocket.close(code=UNSUPPORTED_DATA, reason="text frames only")
            return
        sequence += 1
        if len(text) > MAX_MESSAGE_CHARS:
            await websocket.close(code=MESSAGE_TOO_BIG, reason="message too big")
            return
        if not await respond(websocket, text, sequence):
            return


def create_app(token: str | None = None) -> FastAPI:
    expected_token = token or os.environ.get(TOKEN_ENV, DEFAULT_TOKEN)
    app = FastAPI(title="Tessa websocket echo fixture", docs_url=None, redoc_url=None)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.websocket("/ws")
    async def socket(websocket: WebSocket) -> None:
        await converse(websocket, expected_token)

    return app
