import asyncio
import json
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text

from tessa_api.main import create_app
from tessa_api.schemas.enums import FeedName
from tessa_api.schemas.streams import IngestEvent
from tessa_api.streams.hub import OutboundMessage
from tessa_api.streams.ingest import append_events, append_to_run
from tests.streams.support import (
    OCCURRED_AT,
    count_rows,
    make_batch,
    make_event,
    new_run_id,
    post_events,
    read_rows,
    service_headers,
)
from tests.support import settings_with

pytestmark = pytest.mark.integration

BATCH_COUNT = 50
BATCH_SIZE = 4


async def test_ingest_requires_the_service_key(client: httpx.AsyncClient, db_app: FastAPI) -> None:
    body = {"events": [make_event(new_run_id(), "k").model_dump(mode="json")]}
    missing = await client.post("/internal/v1/run-events", json=body)
    wrong = await client.post(
        "/internal/v1/run-events", json=body, headers={"X-Service-Key": "x" * 40}
    )
    assert missing.status_code == 401
    assert wrong.status_code == 401


async def test_ingest_rejects_a_user_bearer_token(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/internal/v1/run-events",
        json={"events": []},
        headers={"Authorization": "Bearer abc"},
    )
    assert response.status_code == 401


async def test_ingest_assigns_gap_free_seq_from_one(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    response = await post_events(client, db_app.state.settings, make_batch(run_id, "tick", 3))
    assert response.status_code == 200
    assert response.json() == {"accepted": 3, "deduplicated": 0, "seqs": [1, 2, 3]}
    rows = await read_rows(db_app.state.session_factory, run_id)
    assert [row.seq for row in rows] == [1, 2, 3]
    assert [row.dedupe_key for row in rows] == ["tick:0", "tick:1", "tick:2"]
    assert rows[0].type == "hello.tick"
    assert rows[0].payload == {"key": "tick:0"}
    assert rows[0].ts == OCCURRED_AT


async def test_second_batch_continues_the_sequence(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    settings = db_app.state.settings
    await post_events(client, settings, make_batch(run_id, "a", 2))
    response = await post_events(client, settings, make_batch(run_id, "b", 2))
    assert response.json()["seqs"] == [3, 4]


async def test_retried_batch_is_deduplicated_and_returns_the_original_seq(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    settings = db_app.state.settings
    batch = make_batch(run_id, "tick", 3)
    await post_events(client, settings, batch)
    retried = await post_events(client, settings, batch)
    assert retried.json() == {"accepted": 0, "deduplicated": 3, "seqs": [1, 2, 3]}
    assert await count_rows(db_app.state.session_factory, run_id) == 3


async def test_partly_known_batch_inserts_only_the_new_events(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    settings = db_app.state.settings
    await post_events(client, settings, make_batch(run_id, "tick", 2))
    mixed = [make_event(run_id, "tick:1"), make_event(run_id, "tick:2"), make_event(run_id, "x")]
    response = await post_events(client, settings, mixed)
    assert response.json() == {"accepted": 2, "deduplicated": 1, "seqs": [2, 3, 4]}


async def test_duplicate_key_inside_one_batch_is_inserted_once(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    events = [make_event(run_id, "same"), make_event(run_id, "other"), make_event(run_id, "same")]
    response = await post_events(client, db_app.state.settings, events)
    assert response.json() == {"accepted": 2, "deduplicated": 1, "seqs": [1, 2, 1]}


async def test_batch_spanning_runs_keeps_input_order_in_seqs(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    first, second = new_run_id(), new_run_id()
    events = [
        make_event(first, "a1"),
        make_event(second, "b1"),
        make_event(first, "a2"),
        make_event(second, "b2"),
        make_event(second, "b3"),
    ]
    response = await post_events(client, db_app.state.settings, events)
    assert response.json()["seqs"] == [1, 1, 2, 2, 3]


async def test_ephemeral_events_get_no_row_and_no_seq(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    events = [
        make_event(run_id, "k1"),
        make_event(run_id, None, "finding.occurrence_added", ephemeral=True),
        make_event(None, None, "dashboard.invalidate", ephemeral=True),
        make_event(run_id, "k2"),
    ]
    response = await post_events(client, db_app.state.settings, events)
    assert response.json() == {"accepted": 4, "deduplicated": 0, "seqs": [1, None, None, 2]}
    rows = await read_rows(db_app.state.session_factory, run_id)
    assert [row.type for row in rows] == ["hello.tick", "hello.tick"]


async def test_ephemeral_events_do_not_advance_the_sequence(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    settings = db_app.state.settings
    await post_events(
        client, settings, [make_event(run_id, None, "coverage.updated", ephemeral=True)]
    )
    response = await post_events(client, settings, [make_event(run_id, "first")])
    assert response.json()["seqs"] == [1]


async def test_ephemeral_events_reach_only_the_catalog_feeds(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    hub = db_app.state.hub
    home = hub.subscribe_feed(FeedName.home, 10)
    findings = hub.subscribe_feed(FeedName.findings, 10)
    run_stream = hub.subscribe_run(run_id, new_run_id(), 10, 10)
    events = [make_event(run_id, None, "dashboard.invalidate", ephemeral=True)]
    await post_events(client, db_app.state.settings, events)
    assert home.queue.qsize() == 1
    assert findings.queue.qsize() == 0
    assert run_stream is not None
    assert run_stream.queue.qsize() == 0
    message = home.queue.get_nowait()
    assert isinstance(message, OutboundMessage)
    assert message.seq is None


@pytest.mark.parametrize(
    "body",
    [
        {"events": []},
        {"events": [{"type": "hello.tick", "payload": {}, "occurred_at": "2026-09-30T14:03:22Z"}]},
        {
            "events": [
                {
                    "run_id": "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11",
                    "type": "hello.tick",
                    "payload": {},
                    "dedupe_key": "",
                    "occurred_at": "2026-09-30T14:03:22Z",
                }
            ]
        },
        {"events": [{"type": "", "payload": {}, "occurred_at": "2026-09-30T14:03:22Z"}]},
    ],
)
async def test_invalid_batches_are_rejected_without_writing(
    client: httpx.AsyncClient, db_app: FastAPI, body: dict[str, object]
) -> None:
    response = await client.post(
        "/internal/v1/run-events", json=body, headers=service_headers(db_app.state.settings)
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"


async def test_batch_without_a_durable_identity_is_refused_by_the_function(
    db_app: FastAPI,
) -> None:
    broken = IngestEvent.model_construct(
        run_id=None,
        type="hello.tick",
        payload={},
        dedupe_key=None,
        occurred_at=OCCURRED_AT,
        ephemeral=False,
    )
    with pytest.raises(ValueError, match="run_id and dedupe_key"):
        await append_events(db_app.state.session_factory, db_app.state.hub, [broken])


async def test_concurrent_batches_produce_contiguous_seq_without_duplicates(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    settings = db_app.state.settings
    responses = await asyncio.gather(
        *(
            post_events(client, settings, make_batch(run_id, f"batch{batch}", BATCH_SIZE))
            for batch in range(BATCH_COUNT)
        )
    )
    assert all(response.status_code == 200 for response in responses)
    every_seq = sorted(seq for response in responses for seq in response.json()["seqs"])
    assert every_seq == list(range(1, BATCH_COUNT * BATCH_SIZE + 1))
    for response in responses:
        seqs = response.json()["seqs"]
        assert seqs == list(range(seqs[0], seqs[0] + BATCH_SIZE))
    rows = await read_rows(db_app.state.session_factory, run_id)
    assert [row.seq for row in rows] == list(range(1, BATCH_COUNT * BATCH_SIZE + 1))
    assert db_app.state.hub.active_run_locks() == 0


async def test_concurrent_retries_of_one_batch_insert_it_once(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    settings = db_app.state.settings
    batch = make_batch(run_id, "tick", 3)
    responses = await asyncio.gather(*(post_events(client, settings, batch) for _ in range(30)))
    assert sum(response.json()["accepted"] for response in responses) == 3
    assert sum(response.json()["deduplicated"] for response in responses) == 87
    assert all(response.json()["seqs"] == [1, 2, 3] for response in responses)
    assert await count_rows(db_app.state.session_factory, run_id) == 3


@pytest.fixture
async def second_app(db_app: FastAPI) -> AsyncIterator[FastAPI]:
    application = create_app(settings_with())
    async with application.router.lifespan_context(application):
        yield application


async def test_two_api_processes_share_the_sequence_through_the_advisory_lock(
    db_app: FastAPI, second_app: FastAPI
) -> None:
    run_id = new_run_id()
    first_transport = httpx.ASGITransport(app=db_app)
    second_transport = httpx.ASGITransport(app=second_app)
    async with (
        httpx.AsyncClient(transport=first_transport, base_url="http://first") as first,
        httpx.AsyncClient(transport=second_transport, base_url="http://second") as second,
    ):
        settings = db_app.state.settings
        calls = [
            post_events(
                first if batch % 2 == 0 else second, settings, make_batch(run_id, f"b{batch}", 3)
            )
            for batch in range(30)
        ]
        responses = await asyncio.gather(*calls)
    assert all(response.status_code == 200 for response in responses)
    rows = await read_rows(db_app.state.session_factory, run_id)
    assert [row.seq for row in rows] == list(range(1, 91))


async def test_a_writer_that_bypasses_the_advisory_lock_is_detected_not_silently_lost(
    db_app: FastAPI,
) -> None:
    run_id = new_run_id()
    session_factory = db_app.state.session_factory
    rogue = session_factory()
    await rogue.execute(
        text(
            "INSERT INTO run_events (run_id, seq, type, ts, payload, dedupe_key) "
            "VALUES (:run_id, 99, 'hello.tick', now(), '{}'::jsonb, 'contested')"
        ),
        {"run_id": run_id},
    )

    async def honest_append() -> None:
        async with session_factory() as session:
            await append_to_run(session, run_id, [(0, make_event(run_id, "contested"))])

    task = asyncio.create_task(honest_append())
    await asyncio.sleep(0.5)
    assert not task.done()
    await rogue.commit()
    await rogue.close()
    with pytest.raises(RuntimeError, match="broke the seq sequence"):
        await task
    assert await count_rows(session_factory, run_id) == 1


async def test_events_are_published_in_seq_order_after_commit(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    hub = db_app.state.hub
    subscription = hub.subscribe_run(run_id, new_run_id(), 100, 10)
    assert subscription is not None
    await post_events(client, db_app.state.settings, make_batch(run_id, "tick", 3))
    await post_events(client, db_app.state.settings, make_batch(run_id, "tick", 3))
    await post_events(client, db_app.state.settings, [make_event(run_id, "tick:new")])
    received = []
    while not subscription.queue.empty():
        message = subscription.queue.get_nowait()
        assert isinstance(message, OutboundMessage)
        received.append(message.seq)
    assert received == [1, 2, 3, 4]
    subscription.release()


async def test_published_text_is_the_event_envelope(
    client: httpx.AsyncClient, db_app: FastAPI
) -> None:
    run_id = new_run_id()
    subscription = db_app.state.hub.subscribe_run(run_id, new_run_id(), 10, 10)
    assert subscription is not None
    event = make_event(run_id, "k", "hello.tick", {"n": 1, "total": 5, "message": "tick 1"})
    await post_events(client, db_app.state.settings, [event])
    message = subscription.queue.get_nowait()
    assert isinstance(message, OutboundMessage)
    envelope = json.loads(message.text)
    assert envelope == {
        "type": "hello.tick",
        "run_id": str(run_id),
        "seq": 1,
        "ts": "2026-09-30T14:03:22.123Z",
        "payload": {"n": 1, "total": 5, "message": "tick 1"},
    }
