import asyncio
import base64
import json
from typing import Any

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from tessa_api.ids import new_id
from tessa_api.schemas.enums import UserRole
from tests.streams.conftest import LiveServer, StartServer
from tests.streams.support import closed_with, make_batch, new_run_id, receive_event, receive_until
from tests.support import MakeUser

pytestmark = pytest.mark.integration


def frame_message(**overrides: Any) -> str:
    payload: dict[str, Any] = {
        "browser_session_id": str(new_id()),
        "frame_seq": 1,
        "mime": "image/jpeg",
        "width": 640,
        "height": 360,
        "data_b64": base64.b64encode(b"\xff\xd8\xff\xd9").decode(),
        "page_url": "https://app.example/login",
        "captured_at": "2026-09-30T14:03:22.123Z",
    }
    payload.update(overrides)
    return json.dumps({"type": "frame", "payload": payload})


async def open_ingest(server: LiveServer, service_key: str | None) -> Any:
    headers = {"X-Service-Key": service_key} if service_key is not None else {}
    return await connect(
        f"ws://127.0.0.1:{server.port}/internal/v1/frames", additional_headers=headers
    )


async def test_missing_service_key_is_closed_with_4401(server: LiveServer) -> None:
    async with await open_ingest(server, None) as ingest:
        assert await closed_with(ingest) == (4401, "invalid_service_key")


async def test_wrong_service_key_is_closed_with_4401(server: LiveServer) -> None:
    async with await open_ingest(server, "x" * 40) as ingest:
        assert await closed_with(ingest) == (4401, "invalid_service_key")


async def test_user_jwt_is_not_a_service_key(
    server: LiveServer, make_user: MakeUser, auth_headers: Any
) -> None:
    user = await make_user(UserRole.admin)
    token = auth_headers(user)["Authorization"].removeprefix("Bearer ")
    async with await open_ingest(server, token) as ingest:
        assert (await closed_with(ingest))[0] == 4401


async def test_valid_frames_are_accepted_and_the_socket_stays_open(server: LiveServer) -> None:
    key = server.settings.service_key.get_secret_value()
    async with await open_ingest(server, key) as ingest:
        for frame_seq in range(5):
            await ingest.send(frame_message(frame_seq=frame_seq))
        await asyncio.sleep(0.3)
        await ingest.ping()
        assert ingest.close_code is None


@pytest.mark.parametrize(
    "message",
    [
        "not json",
        json.dumps({"type": "frame"}),
        json.dumps({"type": "other", "payload": {}}),
        frame_message(mime="image/png"),
        frame_message(width=0),
        frame_message(data_b64=""),
        frame_message(browser_session_id="nope"),
    ],
)
async def test_invalid_frame_messages_are_closed_with_4400(
    server: LiveServer, message: str
) -> None:
    key = server.settings.service_key.get_secret_value()
    async with await open_ingest(server, key) as ingest:
        await ingest.send(message)
        assert await closed_with(ingest) == (4400, "bad_frame_message")


async def test_a_frame_of_an_unknown_session_reaches_nobody(
    start_server: StartServer, make_user: MakeUser
) -> None:
    server = await start_server(stream_heartbeat_seconds=1)
    run_id = new_run_id()
    await server.post_events(make_batch(run_id, "seed", 1))
    user = await make_user(UserRole.viewer)
    key = server.settings.service_key.get_secret_value()
    async with await server.open_stream(user, run_id, last_seq=1) as stream:
        await receive_until(stream, "stream.replay_end")
        async with await open_ingest(server, key) as ingest:
            await ingest.send(frame_message())
            event = await receive_event(stream)
    assert event["type"] == "stream.heartbeat"


async def test_ingest_socket_ends_quietly_when_the_worker_disconnects(server: LiveServer) -> None:
    key = server.settings.service_key.get_secret_value()
    ingest = await open_ingest(server, key)
    await ingest.send(frame_message())
    await ingest.close()
    with pytest.raises(ConnectionClosed):
        await ingest.recv()
