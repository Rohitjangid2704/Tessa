import asyncio
import socket
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from websockets.asyncio.client import ClientConnection, connect
from websockets.typing import Origin

from tessa_api.db.models import User
from tessa_api.main import create_app
from tessa_api.schemas.streams import IngestEvent
from tessa_api.services.tickets import issue_ticket
from tessa_api.settings import Settings
from tessa_api.streams.hub import Hub
from tests.streams.support import HTTP_TIMEOUT_SECONDS, service_headers
from tests.streams.support import post_events as post_event_batch
from tests.support import settings_with


@dataclass
class LiveServer:
    app: FastAPI
    settings: Settings
    server: uvicorn.Server
    task: "asyncio.Task[None]"
    port: int

    @property
    def http_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def hub(self) -> Hub:
        hub: Hub = self.app.state.hub
        return hub

    def ticket_for(self, user: User, run_id: UUID, issued_at: datetime | None = None) -> str:
        return issue_ticket(self.settings, user.id, run_id, issued_at).ticket

    async def open_stream(
        self,
        user: User,
        run_id: UUID,
        last_seq: int | str | None = None,
        origin: str | None = None,
        ticket: str | None = None,
        path_run_id: str | None = None,
    ) -> ClientConnection:
        token = ticket if ticket is not None else self.ticket_for(user, run_id)
        query = f"ticket={token}" if token else ""
        if last_seq is not None:
            query += f"&last_seq={last_seq}"
        target = path_run_id if path_run_id is not None else str(run_id)
        return await connect(
            f"ws://127.0.0.1:{self.port}/ws/v1/runs/{target}?{query}",
            origin=Origin(origin) if origin is not None else None,
        )

    async def post_events(self, events: list[IngestEvent]) -> httpx.Response:
        async with httpx.AsyncClient(
            base_url=self.http_url, timeout=HTTP_TIMEOUT_SECONDS
        ) as client:
            return await post_event_batch(client, self.settings, events)

    def service_headers(self) -> dict[str, str]:
        return service_headers(self.settings)


StartServer = Callable[..., Awaitable[LiveServer]]


@pytest.fixture
async def start_server(database: None) -> AsyncIterator[StartServer]:
    started: list[LiveServer] = []

    async def start(**overrides: Any) -> LiveServer:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        port = int(listener.getsockname()[1])
        settings = settings_with(public_api_url=f"http://127.0.0.1:{port}", **overrides)
        app = create_app(settings)
        server = uvicorn.Server(uvicorn.Config(app, log_config=None, lifespan="on"))
        task = asyncio.create_task(server.serve(sockets=[listener]))
        while not server.started:
            if task.done():
                task.result()
            await asyncio.sleep(0.01)
        live = LiveServer(app, settings, server, task, port)
        started.append(live)
        return live

    yield start
    for live in started:
        live.server.should_exit = True
    for live in started:
        await live.task


@pytest.fixture
async def server(start_server: StartServer) -> LiveServer:
    return await start_server()
