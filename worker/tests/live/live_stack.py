import asyncio
import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx
from fastapi import FastAPI
from websockets.asyncio.client import ClientConnection, connect

from tessa_api.db.models import User
from tessa_api.ids import new_id
from tessa_api.schemas.events import TileFramePayload
from tessa_api.settings import Settings
from tessa_worker.live.frame_pump import decoded_size, jpeg_dimensions
from tessa_worker.live.uplink import FrameUplink
from tessa_worker.settings import WorkerSettings

HTTP_TIMEOUT_SECONDS = 60.0
RECEIVE_TIMEOUT_SECONDS = 30.0
STARTED_AT = "2026-10-05T09:00:00.000Z"


@dataclass
class ApiEndpoint:
    base_url: str
    settings: Settings
    user: User
    headers: dict[str, str]

    @property
    def websocket_base(self) -> str:
        return self.base_url.replace("http://", "ws://", 1)

    async def post_events(self, events: list[dict[str, Any]]) -> None:
        async with httpx.AsyncClient(
            base_url=self.base_url, timeout=HTTP_TIMEOUT_SECONDS
        ) as client:
            response = await client.post(
                "/internal/v1/run-events",
                json={"events": events},
                headers={"X-Service-Key": self.settings.service_key.get_secret_value()},
            )
        assert response.status_code == 200, response.text

    async def announce_session(self, run_id: UUID, session_id: UUID) -> None:
        await self.post_events(
            [
                {
                    "run_id": str(run_id),
                    "type": "browser_session.started",
                    "payload": {
                        "browser_session_id": str(session_id),
                        "run_scenario_id": str(new_id()),
                        "attempt": 0,
                        "viewport": {"width": 1280, "height": 720},
                        "scenario_title": "Live view",
                        "started_at": STARTED_AT,
                    },
                    "dedupe_key": f"started:{session_id}",
                    "occurred_at": datetime.now(UTC).isoformat(),
                }
            ]
        )

    async def end_session(self, run_id: UUID, session_id: UUID) -> None:
        await self.post_events(
            [
                {
                    "run_id": str(run_id),
                    "type": "browser_session.ended",
                    "payload": {
                        "browser_session_id": str(session_id),
                        "run_scenario_id": str(new_id()),
                        "has_recording": True,
                        "has_trace": True,
                        "ended_at": STARTED_AT,
                    },
                    "dedupe_key": f"ended:{session_id}",
                    "occurred_at": datetime.now(UTC).isoformat(),
                }
            ]
        )

    async def open_stream(self, run_id: UUID) -> ClientConnection:
        async with httpx.AsyncClient(
            base_url=self.base_url, timeout=HTTP_TIMEOUT_SECONDS
        ) as client:
            response = await client.post(
                "/api/v1/ws-tickets", json={"run_id": str(run_id)}, headers=self.headers
            )
        assert response.status_code == 200, response.text
        ticket = response.json()["ticket"]
        stream = await connect(
            f"{self.websocket_base}/ws/v1/runs/{run_id}?ticket={ticket}&last_seq=0"
        )
        while (
            json.loads(await asyncio.wait_for(stream.recv(), RECEIVE_TIMEOUT_SECONDS))["type"]
            != "stream.replay_end"
        ):
            continue
        return stream


@dataclass
class LiveApi(ApiEndpoint):
    app: FastAPI


@dataclass
class ExternalApi(ApiEndpoint):
    pid: int


@dataclass(frozen=True)
class ReceivedFrame:
    payload: TileFramePayload
    arrived_at: float
    size_bytes: int
    width: int


def subscribe_message(session_id: UUID, mode: str) -> str:
    tiles = [] if mode == "none" else [{"browser_session_id": str(session_id), "mode": mode}]
    return json.dumps({"type": "tile.subscribe", "payload": {"tiles": tiles}})


def subscribe_many(session_ids: list[UUID], mode: str) -> str:
    tiles = [{"browser_session_id": str(session_id), "mode": mode} for session_id in session_ids]
    return json.dumps({"type": "tile.subscribe", "payload": {"tiles": tiles}})


def ack_message(session_id: UUID, frame_seq: int) -> str:
    return json.dumps(
        {
            "type": "tile.ack",
            "payload": {"browser_session_id": str(session_id), "frame_seq": frame_seq},
        }
    )


async def collect_tile_frames(
    stream: ClientConnection, seconds: float, acknowledge: bool = True
) -> dict[UUID, list[ReceivedFrame]]:
    frames: dict[UUID, list[ReceivedFrame]] = {}
    deadline = time.monotonic() + seconds
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            raw = await asyncio.wait_for(stream.recv(), remaining)
        except TimeoutError:
            break
        event = json.loads(raw)
        if event["type"] != "tile.frame":
            continue
        payload = TileFramePayload.model_validate(event["payload"])
        dimensions = jpeg_dimensions(payload.data_b64)
        assert dimensions is not None
        frames.setdefault(payload.browser_session_id, []).append(
            ReceivedFrame(payload, time.monotonic(), decoded_size(payload.data_b64), dimensions[0])
        )
        if acknowledge:
            await stream.send(ack_message(payload.browser_session_id, payload.frame_seq))
    return frames


async def collect_frames(
    stream: ClientConnection, session_id: UUID, seconds: float, acknowledge: bool = True
) -> list[ReceivedFrame]:
    collected = await collect_tile_frames(stream, seconds, acknowledge)
    return collected.get(session_id, [])


def uplink_settings(worker_settings: WorkerSettings, api: ApiEndpoint) -> WorkerSettings:
    return worker_settings.model_copy(
        update={"api_internal_url": api.base_url, "service_key": api.settings.service_key}
    )


async def connected_uplink(worker_settings: WorkerSettings, api: ApiEndpoint) -> FrameUplink:
    uplink = FrameUplink(uplink_settings(worker_settings, api))
    await uplink.start()
    await uplink.wait_connected(20)
    return uplink
