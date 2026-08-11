import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from tests.streams.support import RECEIVE_TIMEOUT_SECONDS


@dataclass(frozen=True)
class SseFrame:
    event: str | None
    data: dict[str, Any] | None
    comment: str | None


class SseReader:
    def __init__(self, response: httpx.Response) -> None:
        self._lines: AsyncIterator[str] = response.aiter_lines()

    async def next_frame(self, patience_seconds: float = RECEIVE_TIMEOUT_SECONDS) -> SseFrame:
        event: str | None = None
        data: str | None = None
        comment: str | None = None
        async with asyncio.timeout(patience_seconds):
            async for line in self._lines:
                if line == "":
                    if event is not None or data is not None or comment is not None:
                        break
                    continue
                if line.startswith(":"):
                    comment = line
                elif line.startswith("event: "):
                    event = line.removeprefix("event: ")
                elif line.startswith("data: "):
                    data = line.removeprefix("data: ")
            else:
                raise EOFError("the stream ended")
        return SseFrame(event, None if data is None else json.loads(data), comment)

    async def next_event(self, patience_seconds: float = RECEIVE_TIMEOUT_SECONDS) -> SseFrame:
        while True:
            frame = await self.next_frame(patience_seconds)
            if frame.event is not None:
                return frame

    async def events_until(self, event_type: str) -> list[SseFrame]:
        collected: list[SseFrame] = []
        while True:
            frame = await self.next_event()
            collected.append(frame)
            if frame.event == event_type:
                return collected

    async def ended(self, patience_seconds: float = RECEIVE_TIMEOUT_SECONDS) -> bool:
        try:
            await self.next_frame(patience_seconds)
        except EOFError:
            return True
        return False
