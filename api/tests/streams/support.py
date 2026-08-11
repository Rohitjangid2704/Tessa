import asyncio
import contextlib
import json
import time
import uuid
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import func, select
from websockets.asyncio.client import ClientConnection
from websockets.exceptions import ConnectionClosed

from tessa_api.db.models import RunEventRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.streams import IngestEvent, IngestEventBatch
from tessa_api.settings import Settings
from tessa_api.streams.hub import Hub
from tessa_api.streams.tiles import tile_policy
from tests.support import settings_with

OCCURRED_AT = datetime(2026, 9, 30, 14, 3, 22, 123000, tzinfo=UTC)
RECEIVE_TIMEOUT_SECONDS = 30.0
HTTP_TIMEOUT_SECONDS = 60.0
EVENTUALLY_POLL_SECONDS = 0.02


def new_hub(clock: Callable[[], float] = time.monotonic, **overrides: Any) -> Hub:
    return Hub(tile_policy(settings_with(**overrides)), clock)


def make_event(
    run_id: uuid.UUID | None,
    key: str | None,
    event_type: str = "hello.tick",
    payload: dict[str, Any] | None = None,
    ephemeral: bool = False,
) -> IngestEvent:
    return IngestEvent(
        run_id=run_id,
        type=event_type,
        payload=payload if payload is not None else {"key": key},
        dedupe_key=key,
        occurred_at=OCCURRED_AT,
        ephemeral=ephemeral,
    )


def make_batch(run_id: uuid.UUID, prefix: str, count: int) -> list[IngestEvent]:
    return [make_event(run_id, f"{prefix}:{index}") for index in range(count)]


def service_headers(settings: Settings) -> dict[str, str]:
    return {"X-Service-Key": settings.service_key.get_secret_value()}


async def post_events(
    client: httpx.AsyncClient, settings: Settings, events: Sequence[IngestEvent]
) -> httpx.Response:
    body = IngestEventBatch(events=list(events)).model_dump(mode="json")
    return await client.post(
        "/internal/v1/run-events", json=body, headers=service_headers(settings)
    )


async def read_rows(session_factory: SessionFactory, run_id: uuid.UUID) -> list[RunEventRow]:
    async with session_factory() as session:
        result = await session.scalars(
            select(RunEventRow).where(RunEventRow.run_id == run_id).order_by(RunEventRow.seq)
        )
        return list(result.all())


async def count_rows(session_factory: SessionFactory, run_id: uuid.UUID) -> int:
    async with session_factory() as session:
        total = await session.scalar(
            select(func.count()).select_from(RunEventRow).where(RunEventRow.run_id == run_id)
        )
        return total or 0


def new_run_id() -> uuid.UUID:
    return new_id()


async def receive_event(connection: ClientConnection) -> dict[str, Any]:
    async with asyncio.timeout(RECEIVE_TIMEOUT_SECONDS):
        raw = await connection.recv()
    event: dict[str, Any] = json.loads(raw)
    return event


async def receive_until(connection: ClientConnection, event_type: str) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    while True:
        event = await receive_event(connection)
        collected.append(event)
        if event["type"] == event_type:
            return collected


async def receive_seqs(connection: ClientConnection, last_seq: int) -> list[int]:
    seqs: list[int] = []
    while True:
        event = await receive_event(connection)
        if event["seq"] is not None:
            seqs.append(event["seq"])
            if event["seq"] >= last_seq:
                return seqs


async def eventually(
    predicate: Callable[[], bool], patience_seconds: float = RECEIVE_TIMEOUT_SECONDS
) -> None:
    for _ in range(int(patience_seconds / EVENTUALLY_POLL_SECONDS)):
        if predicate():
            return
        await asyncio.sleep(EVENTUALLY_POLL_SECONDS)
    raise AssertionError("condition did not become true in time")


async def closed_with(connection: ClientConnection) -> tuple[int, str]:
    async with asyncio.timeout(RECEIVE_TIMEOUT_SECONDS):
        with contextlib.suppress(ConnectionClosed):
            while True:
                await connection.recv()
    assert connection.close_code is not None
    return connection.close_code, connection.close_reason or ""
