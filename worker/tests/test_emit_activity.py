import json
from collections import Counter
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
import pytest
import respx
from pydantic import SecretStr
from sqlalchemy import select
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment, WorkflowEnvironment

from tessa_api.db.models import RunEventRow
from tessa_api.schemas.hello import EmitRunEventInput, EmitRunEventResult
from tessa_worker.activities.events import EventActivities
from tessa_worker.settings import WorkerSettings
from tests.hello_support import StubLaya, hello_input, run_hello, running_worker

INGEST_URL = "http://testserver/internal/v1/run-events"


@pytest.fixture
async def fake_api_client() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as client:
        yield client


def emit_request(
    event_type: str = "hello.tick", dedupe_key: str | None = "tick:1", ephemeral: bool = False
) -> EmitRunEventInput:
    return EmitRunEventInput(
        run_id=uuid4(),
        type=event_type,
        payload={"n": 1, "total": 5, "message": "tick 1 of 5"},
        dedupe_key=dedupe_key,
        ephemeral=ephemeral,
    )


async def emit(activities: EventActivities, request: EmitRunEventInput) -> EmitRunEventResult:
    result: EmitRunEventResult = await ActivityEnvironment().run(activities.emit_run_event, request)
    return result


def ingest_result(*seqs: int | None) -> dict[str, Any]:
    return {"accepted": len(seqs), "deduplicated": 0, "seqs": list(seqs)}


@respx.mock
async def test_posts_one_event_with_the_service_key_and_returns_its_seq(
    worker_settings: WorkerSettings, fake_api_client: httpx.AsyncClient
) -> None:
    route = respx.post(INGEST_URL).respond(200, json=ingest_result(7))
    request = emit_request()
    before = datetime.now(UTC)
    result = await emit(EventActivities(worker_settings, fake_api_client), request)
    after = datetime.now(UTC)
    assert result == EmitRunEventResult(seq=7)
    sent = route.calls.last.request
    assert sent.headers["X-Service-Key"] == worker_settings.service_key.get_secret_value()
    body = json.loads(sent.content)
    assert list(body) == ["events"]
    [event] = body["events"]
    assert event["run_id"] == str(request.run_id)
    assert event["type"] == "hello.tick"
    assert event["dedupe_key"] == "tick:1"
    assert event["payload"] == request.payload
    assert event["ephemeral"] is False
    occurred_at = datetime.fromisoformat(event["occurred_at"])
    assert before - timedelta(seconds=1) <= occurred_at <= after + timedelta(seconds=1)
    assert event["occurred_at"].endswith("Z")


@respx.mock
async def test_an_ephemeral_event_returns_a_null_seq(
    worker_settings: WorkerSettings, fake_api_client: httpx.AsyncClient
) -> None:
    route = respx.post(INGEST_URL).respond(200, json=ingest_result(None))
    request = emit_request("dashboard.invalidate", dedupe_key=None, ephemeral=True)
    result = await emit(EventActivities(worker_settings, fake_api_client), request)
    assert result == EmitRunEventResult(seq=None)
    assert json.loads(route.calls.last.request.content)["events"][0]["ephemeral"] is True


@respx.mock
@pytest.mark.parametrize("status_code", [400, 401, 403, 404, 422])
async def test_a_client_error_is_not_retried(
    worker_settings: WorkerSettings, fake_api_client: httpx.AsyncClient, status_code: int
) -> None:
    respx.post(INGEST_URL).respond(status_code, json={"error": {"code": "nope"}})
    with pytest.raises(ApplicationError) as caught:
        await emit(EventActivities(worker_settings, fake_api_client), emit_request())
    assert caught.value.non_retryable is True
    assert f"HTTP {status_code}" in str(caught.value)


@respx.mock
@pytest.mark.parametrize("status_code", [408, 429, 500, 502, 503])
async def test_a_server_error_or_throttle_is_retryable(
    worker_settings: WorkerSettings, fake_api_client: httpx.AsyncClient, status_code: int
) -> None:
    respx.post(INGEST_URL).respond(status_code)
    with pytest.raises(httpx.HTTPStatusError) as caught:
        await emit(EventActivities(worker_settings, fake_api_client), emit_request())
    assert caught.value.response.status_code == status_code


@respx.mock
async def test_a_refused_connection_is_retryable(
    worker_settings: WorkerSettings, fake_api_client: httpx.AsyncClient
) -> None:
    respx.post(INGEST_URL).mock(side_effect=httpx.ConnectError("connection refused"))
    with pytest.raises(httpx.ConnectError):
        await emit(EventActivities(worker_settings, fake_api_client), emit_request())


@respx.mock
async def test_the_service_key_never_appears_in_a_failure_message(
    worker_settings: WorkerSettings, fake_api_client: httpx.AsyncClient
) -> None:
    respx.post(INGEST_URL).respond(401, json={"error": {"code": "unauthenticated"}})
    with pytest.raises(ApplicationError) as caught:
        await emit(EventActivities(worker_settings, fake_api_client), emit_request())
    assert worker_settings.service_key.get_secret_value() not in str(caught.value)


@pytest.mark.integration
@respx.mock
async def test_the_workflow_retries_a_failing_ingest_until_it_succeeds(
    worker_settings: WorkerSettings,
    temporal_env: WorkflowEnvironment,
    fake_api_client: httpx.AsyncClient,
) -> None:
    attempts: Counter[str] = Counter()
    delivered: list[str] = []

    def ingest(request: httpx.Request) -> httpx.Response:
        event = json.loads(request.content)["events"][0]
        key = event["dedupe_key"]
        attempts[key] += 1
        if key == "tick:1" and attempts[key] < 3:
            return httpx.Response(503)
        delivered.append(key)
        return httpx.Response(200, json=ingest_result(len(delivered)))

    respx.post(INGEST_URL).mock(side_effect=ingest)
    activities = EventActivities(worker_settings, fake_api_client)
    request = hello_input(ticks=1, include_laya=False)
    async with running_worker(
        temporal_env, [activities.emit_run_event, StubLaya().laya_smoke_call]
    ):
        result = await run_hello(temporal_env, request)
    assert attempts["tick:1"] == 3
    assert delivered == ["status:running", "tick:1", "finished"]
    assert result.ticks_emitted == 1


@pytest.mark.integration
async def test_emit_against_the_ingest_endpoint_allocates_contiguous_seqs(
    worker_settings: WorkerSettings, api_app: Any, asgi_client: httpx.AsyncClient
) -> None:
    activities = EventActivities(worker_settings, asgi_client)
    run_id = uuid4()
    seqs = []
    for number in range(1, 4):
        request = EmitRunEventInput(
            run_id=run_id,
            type="hello.tick",
            payload={"n": number, "total": 3, "message": f"tick {number} of 3"},
            dedupe_key=f"tick:{number}",
        )
        seqs.append((await emit(activities, request)).seq)
    assert seqs == [1, 2, 3]
    async with api_app.state.session_factory() as session:
        rows = (await session.scalars(select(RunEventRow).order_by(RunEventRow.seq))).all()
    assert [(row.seq, row.dedupe_key, row.type) for row in rows] == [
        (1, "tick:1", "hello.tick"),
        (2, "tick:2", "hello.tick"),
        (3, "tick:3", "hello.tick"),
    ]
    assert rows[0].payload == {"n": 1, "total": 3, "message": "tick 1 of 3"}


@pytest.mark.integration
async def test_emitting_the_same_dedupe_key_twice_returns_the_original_seq_and_one_row(
    worker_settings: WorkerSettings, api_app: Any, asgi_client: httpx.AsyncClient
) -> None:
    activities = EventActivities(worker_settings, asgi_client)
    request = emit_request()
    first = await emit(activities, request)
    again = await emit(activities, request)
    other = await emit(
        activities,
        EmitRunEventInput(
            run_id=request.run_id,
            type="hello.tick",
            payload={"n": 2, "total": 5, "message": "tick 2 of 5"},
            dedupe_key="tick:2",
        ),
    )
    assert (first.seq, again.seq, other.seq) == (1, 1, 2)
    async with api_app.state.session_factory() as session:
        rows = (await session.scalars(select(RunEventRow))).all()
    assert len(rows) == 2


@pytest.mark.integration
async def test_a_wrong_service_key_is_rejected_without_a_retry_and_stores_nothing(
    worker_settings: WorkerSettings, api_app: Any, asgi_client: httpx.AsyncClient
) -> None:
    wrong = worker_settings.model_copy(update={"service_key": SecretStr("x" * 40)})
    with pytest.raises(ApplicationError) as caught:
        await emit(EventActivities(wrong, asgi_client), emit_request())
    assert caught.value.non_retryable is True
    assert "HTTP 401" in str(caught.value)
    async with api_app.state.session_factory() as session:
        assert (await session.scalars(select(RunEventRow))).all() == []
