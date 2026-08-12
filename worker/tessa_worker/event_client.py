import asyncio
import contextlib
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from types import TracebackType
from typing import Any, Self
from uuid import UUID

import httpx
from pydantic import BaseModel
from temporalio.exceptions import ApplicationError

from tessa_api.schemas.streams import IngestEvent, IngestEventBatch, IngestEventResult
from tessa_worker.settings import WorkerSettings

INGEST_PATH = "/internal/v1/run-events"
SERVICE_KEY_HEADER = "X-Service-Key"
RETRYABLE_CLIENT_ERRORS = frozenset({408, 429})
REQUEST_TIMEOUT_SECONDS = 8.0
MAX_EVENTS_PER_REQUEST = 500
DEFAULT_BATCH_SIZE = 100
DEFAULT_LINGER_SECONDS = 0.05
DEFAULT_FLUSH_TIMEOUT_SECONDS = 20.0

logger = logging.getLogger("tessa_worker.events")


@dataclass(frozen=True, slots=True)
class DeliveryPolicy:
    attempts: int = 5
    initial_delay_seconds: float = 0.25
    max_delay_seconds: float = 4.0


DEFAULT_DELIVERY_POLICY = DeliveryPolicy()


def event_payload(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True)


def build_event(
    run_id: UUID, event_type: str, payload: BaseModel | dict[str, Any], dedupe_key: str
) -> IngestEvent:
    return IngestEvent(
        run_id=run_id,
        type=event_type,
        payload=event_payload(payload) if isinstance(payload, BaseModel) else payload,
        dedupe_key=dedupe_key,
        occurred_at=datetime.now(UTC),
    )


def describe_events(events: Sequence[IngestEvent]) -> list[str]:
    return [f"{event.type}:{event.dedupe_key}" for event in events]


class EventClient:
    def __init__(
        self,
        settings: WorkerSettings,
        http: httpx.AsyncClient,
        policy: DeliveryPolicy = DEFAULT_DELIVERY_POLICY,
    ) -> None:
        self.settings = settings
        self.http = http
        self.policy = policy

    async def post(self, events: Sequence[IngestEvent]) -> IngestEventResult:
        batch = IngestEventBatch(events=list(events))
        response = await self.http.post(
            f"{self.settings.api_internal_url}{INGEST_PATH}",
            json=batch.model_dump(mode="json"),
            headers={SERVICE_KEY_HEADER: self.settings.service_key.get_secret_value()},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        if (
            400 <= response.status_code < 500
            and response.status_code not in RETRYABLE_CLIENT_ERRORS
        ):
            raise ApplicationError(
                f"event ingest rejected {events[0].type} with HTTP {response.status_code}",
                non_retryable=True,
            )
        response.raise_for_status()
        return IngestEventResult.model_validate(response.json())

    async def deliver_all(self, events: Sequence[IngestEvent]) -> None:
        for start in range(0, len(events), MAX_EVENTS_PER_REQUEST):
            await self.deliver(events[start : start + MAX_EVENTS_PER_REQUEST])

    async def deliver(self, events: Sequence[IngestEvent]) -> IngestEventResult | None:
        delay = self.policy.initial_delay_seconds
        for attempt in range(1, self.policy.attempts + 1):
            try:
                return await self.post(events)
            except ApplicationError as rejected:
                logger.warning(
                    "run_events_rejected",
                    extra={"events": describe_events(events), "reason": str(rejected)},
                )
                return None
            except httpx.HTTPError as failure:
                if attempt == self.policy.attempts:
                    logger.warning(
                        "run_events_not_delivered",
                        extra={
                            "events": describe_events(events),
                            "cause": type(failure).__name__,
                            "attempts": attempt,
                        },
                    )
                    return None
                await asyncio.sleep(delay)
                delay = min(delay * 2, self.policy.max_delay_seconds)
        return None

    async def emit(self, event: IngestEvent) -> int | None:
        result = await self.deliver([event])
        return None if result is None else result.seqs[0]

    def batcher(
        self,
        max_batch: int = DEFAULT_BATCH_SIZE,
        linger_seconds: float = DEFAULT_LINGER_SECONDS,
        flush_timeout_seconds: float = DEFAULT_FLUSH_TIMEOUT_SECONDS,
    ) -> "EventBatcher":
        return EventBatcher(self, max_batch, linger_seconds, flush_timeout_seconds)


class EventBatcher:
    def __init__(
        self,
        client: EventClient,
        max_batch: int,
        linger_seconds: float,
        flush_timeout_seconds: float,
    ) -> None:
        if not 1 <= max_batch <= MAX_EVENTS_PER_REQUEST:
            raise ValueError(f"max_batch must be between 1 and {MAX_EVENTS_PER_REQUEST}")
        self.client = client
        self.max_batch = max_batch
        self.linger_seconds = linger_seconds
        self.flush_timeout_seconds = flush_timeout_seconds
        self.queue: asyncio.Queue[IngestEvent] = asyncio.Queue()
        self.pump: asyncio.Task[None] | None = None

    async def __aenter__(self) -> Self:
        self.pump = asyncio.create_task(self.run())
        return self

    async def __aexit__(
        self,
        error_type: type[BaseException] | None,
        error: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        try:
            await self.flush()
        finally:
            await self.stop()

    def add(self, event: IngestEvent) -> None:
        self.queue.put_nowait(event)

    async def flush(self) -> None:
        try:
            async with asyncio.timeout(self.flush_timeout_seconds):
                await self.queue.join()
        except TimeoutError:
            logger.warning("run_event_flush_timed_out", extra={"pending": self.queue.qsize()})

    async def stop(self) -> None:
        if self.pump is None:
            return
        self.pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.pump
        self.pump = None

    async def run(self) -> None:
        while True:
            batch = [await self.queue.get()]
            await asyncio.sleep(self.linger_seconds)
            while len(batch) < self.max_batch and not self.queue.empty():
                batch.append(self.queue.get_nowait())
            try:
                await self.client.deliver(batch)
            except Exception:
                logger.exception("run_event_batch_failed", extra={"events": describe_events(batch)})
            finally:
                for _ in batch:
                    self.queue.task_done()
