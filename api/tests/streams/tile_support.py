import asyncio
import base64
import contextlib
import json
from typing import Any
from uuid import UUID

from websockets.asyncio.client import ClientConnection, connect

from tessa_api.ids import new_id
from tessa_api.schemas.events import TileFramePayload
from tessa_api.schemas.streams import TileSubscription
from tessa_api.streams.tiles import TileFrame, TileMode
from tests.streams.support import OCCURRED_AT, RECEIVE_TIMEOUT_SECONDS, receive_event

JPEG_BYTES = b"\xff\xd8\xff\xe0tile\xff\xd9"


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def frame_payload(session_id: UUID, frame_seq: int, **overrides: object) -> TileFramePayload:
    fields: dict[str, object] = {
        "browser_session_id": session_id,
        "frame_seq": frame_seq,
        "mime": "image/jpeg",
        "width": 640,
        "height": 360,
        "data_b64": base64.b64encode(JPEG_BYTES).decode(),
        "page_url": "http://app.test/login",
        "captured_at": OCCURRED_AT,
    }
    fields.update(overrides)
    return TileFramePayload.model_validate(fields)


def make_frame(session_id: UUID, frame_seq: int, run_id: UUID | None = None) -> TileFrame:
    return TileFrame(run_id or new_id(), frame_payload(session_id, frame_seq))


def subscription(session_id: UUID, mode: TileMode = "grid") -> TileSubscription:
    return TileSubscription(browser_session_id=session_id, mode=mode)


def frame_text(session_id: UUID, frame_seq: int) -> str:
    return json.dumps(
        {"type": "frame", "payload": frame_payload(session_id, frame_seq).model_dump(mode="json")}
    )


def subscribe_text(*tiles: tuple[UUID, TileMode]) -> str:
    return json.dumps(
        {
            "type": "tile.subscribe",
            "payload": {
                "tiles": [
                    {"browser_session_id": str(session_id), "mode": mode}
                    for session_id, mode in tiles
                ]
            },
        }
    )


def ack_text(session_id: UUID, frame_seq: int) -> str:
    return json.dumps(
        {
            "type": "tile.ack",
            "payload": {"browser_session_id": str(session_id), "frame_seq": frame_seq},
        }
    )


async def open_worker_socket(port: int, service_key: str | None) -> ClientConnection:
    headers = {"X-Service-Key": service_key} if service_key is not None else {}
    return await connect(f"ws://127.0.0.1:{port}/internal/v1/frames", additional_headers=headers)


async def receive_demand(worker: ClientConnection) -> dict[str, Any]:
    async with asyncio.timeout(RECEIVE_TIMEOUT_SECONDS):
        raw = await worker.recv()
    message: dict[str, Any] = json.loads(raw)
    return message


async def receive_demand_until(
    worker: ClientConnection, session_id: UUID, max_fps: int
) -> dict[str, Any]:
    while True:
        message = await receive_demand(worker)
        payload = message["payload"]
        if payload["browser_session_id"] == str(session_id) and payload["max_fps"] == max_fps:
            return message


async def receive_tile_frame(stream: ClientConnection) -> dict[str, Any]:
    while True:
        event = await receive_event(stream)
        if event["type"] == "tile.frame":
            return event


async def tile_frames_within(stream: ClientConnection, seconds: float) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []
    with contextlib.suppress(TimeoutError):
        async with asyncio.timeout(seconds):
            while True:
                seen.append(await receive_event(stream))
    return [event for event in seen if event["type"] == "tile.frame"]
