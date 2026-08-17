import asyncio
import uuid

import pytest
from temporalio.exceptions import ApplicationError

from tessa_api.schemas.streams import IngestEvent
from tessa_worker.event_client import (
    MAX_EVENTS_PER_REQUEST,
    EventClient,
    build_event,
)
from tessa_worker.settings import WorkerSettings
from tests.runs.support import RecordingIngest

RUN_ID = uuid.uuid4()


def numbered_event(number: int, run_id: uuid.UUID = RUN_ID) -> IngestEvent:
    return build_event(
        run_id, "hello.tick", {"n": number, "total": 999, "message": ""}, f"n:{number}"
    )


async def test_post_sends_the_batch_with_the_service_key(
    event_client: EventClient, ingest: RecordingIngest, worker_settings: WorkerSettings
) -> None:
    result = await event_client.post([numbered_event(1), numbered_event(2)])
    assert result.seqs == [1, 2]
    assert [event.dedupe_key for event in ingest.requests[0]] == ["n:1", "n:2"]


async def test_a_rejected_batch_is_not_retried_and_never_raises_from_deliver(
    event_client: EventClient, ingest: RecordingIngest
) -> None:
    ingest.rejected_status = 422
    assert await event_client.deliver([numbered_event(1)]) is None
    assert ingest.attempts == 1
    with pytest.raises(ApplicationError) as caught:
        await event_client.post([numbered_event(1)])
    assert caught.value.non_retryable is True


async def test_a_transient_failure_is_retried_until_the_batch_is_accepted(
    event_client: EventClient, ingest: RecordingIngest
) -> None:
    ingest.failures_before_success = 2
    result = await event_client.deliver([numbered_event(1)])
    assert result is not None
    assert ingest.attempts == 3
    assert ingest.types == ["hello.tick"]


async def test_deliver_gives_up_after_the_last_attempt_without_raising(
    event_client: EventClient, ingest: RecordingIngest
) -> None:
    ingest.failures_before_success = 10
    assert await event_client.deliver([numbered_event(1)]) is None
    assert ingest.attempts == 3
    assert ingest.events == []


async def test_deliver_all_splits_batches_at_the_ingest_limit(
    event_client: EventClient, ingest: RecordingIngest
) -> None:
    total = MAX_EVENTS_PER_REQUEST + 5
    await event_client.deliver_all([numbered_event(number) for number in range(total)])
    assert [len(batch) for batch in ingest.requests] == [MAX_EVENTS_PER_REQUEST, 5]
    assert len(ingest.events) == total


async def test_the_batcher_delivers_every_event_in_order_with_fewer_requests(
    event_client: EventClient, ingest: RecordingIngest
) -> None:
    async with event_client.batcher(max_batch=50, linger_seconds=0.02) as batcher:
        for number in range(200):
            batcher.add(numbered_event(number))
            if number % 40 == 0:
                await asyncio.sleep(0)
        await batcher.flush()
        assert len(ingest.events) == 200
    assert [event.payload["n"] for event in ingest.events] == list(range(200))
    assert len(ingest.requests) < 200
    assert all(len(batch) <= 50 for batch in ingest.requests)
    assert ingest.seqs_for(RUN_ID) == list(range(1, 201))


async def test_the_batcher_flushes_what_is_pending_when_it_exits(
    event_client: EventClient, ingest: RecordingIngest
) -> None:
    async with event_client.batcher(linger_seconds=0.5) as batcher:
        batcher.add(numbered_event(1))
        batcher.add(numbered_event(2))
    assert [event.payload["n"] for event in ingest.events] == [1, 2]


async def test_the_batcher_loses_nothing_across_a_transient_outage(
    event_client: EventClient, ingest: RecordingIngest
) -> None:
    ingest.failures_before_success = 2
    async with event_client.batcher(linger_seconds=0.01) as batcher:
        for number in range(10):
            batcher.add(numbered_event(number))
        await batcher.flush()
    assert [event.payload["n"] for event in ingest.events] == list(range(10))


async def test_a_permanently_failing_ingest_does_not_block_the_batcher(
    event_client: EventClient, ingest: RecordingIngest
) -> None:
    ingest.failures_before_success = 1000
    async with event_client.batcher(linger_seconds=0.01) as batcher:
        batcher.add(numbered_event(1))
        await batcher.flush()
        ingest.failures_before_success = 0
        batcher.add(numbered_event(2))
        await batcher.flush()
    assert [event.payload["n"] for event in ingest.events] == [2]


async def test_the_batcher_rejects_a_batch_size_above_the_ingest_limit(
    event_client: EventClient,
) -> None:
    with pytest.raises(ValueError, match="max_batch"):
        event_client.batcher(max_batch=MAX_EVENTS_PER_REQUEST + 1)
