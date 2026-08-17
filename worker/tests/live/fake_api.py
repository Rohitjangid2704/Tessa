import json
from typing import Any
from uuid import UUID

from websockets.asyncio.server import Server, ServerConnection, serve


class FakeFrameApi:
    def __init__(self, service_key: str) -> None:
        self.service_key = service_key
        self.received: list[dict[str, Any]] = []
        self.connections: list[ServerConnection] = []
        self.handshakes = 0
        self.server: Server | None = None
        self.port = 0

    async def start(self, port: int = 0) -> None:
        self.server = await serve(self._handle, "127.0.0.1", port)
        self.port = int(next(iter(self.server.sockets)).getsockname()[1])

    async def stop(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            self.server = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def frames(self) -> list[dict[str, Any]]:
        return [message for message in self.received if message.get("type") == "frame"]

    async def send_demand(
        self, session_id: UUID, max_fps: int, quality: int, max_width: int
    ) -> None:
        message = {
            "type": "tile.demand",
            "payload": {
                "browser_session_id": str(session_id),
                "max_fps": max_fps,
                "quality": quality,
                "max_width": max_width,
            },
        }
        for connection in tuple(self.connections):
            await connection.send(json.dumps(message))

    async def send_raw(self, text: str) -> None:
        for connection in tuple(self.connections):
            await connection.send(text)

    async def drop_connections(self, code: int = 1001) -> None:
        for connection in tuple(self.connections):
            await connection.close(code)

    async def _handle(self, connection: ServerConnection) -> None:
        self.handshakes += 1
        provided = connection.request.headers.get("X-Service-Key") if connection.request else None
        if provided != self.service_key:
            await connection.close(4401, "invalid_service_key")
            return
        self.connections.append(connection)
        try:
            async for raw in connection:
                self.received.append(json.loads(raw))
        finally:
            if connection in self.connections:
                self.connections.remove(connection)
