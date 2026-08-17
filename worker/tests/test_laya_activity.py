import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import respx
from temporalio.testing import ActivityEnvironment

from tessa_api.schemas.hello import LayaSmokeInput, LayaSmokeResult
from tessa_worker.activities.laya import LayaActivities, call_laya_smoke
from tessa_worker.settings import WorkerSettings
from tests.support import TEST_LAYA_URL

SYSTEMONE_URL = f"{TEST_LAYA_URL}/v1/systemone"
SMOKE_TEXT = "Hello from Tessa"

SUCCESS_BODY: dict[str, Any] = {
    "model": "laya-rl-agent",
    "answers": {
        "smoke": {
            "type": "noul",
            "noul": 0.879,
            "confidence": 0.879,
            "answer_confidence": 0.879,
            "action": {"act_probability": 1.0},
        }
    },
    "usage": {"input_tokens": 20},
    "routing": {"model": "english"},
}


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def laya_activities(worker_settings: WorkerSettings, http: httpx.AsyncClient) -> LayaActivities:
    return LayaActivities(worker_settings, http)


async def run_activity(laya_activities: LayaActivities) -> LayaSmokeResult:
    result: LayaSmokeResult = await ActivityEnvironment().run(
        laya_activities.laya_smoke_call, LayaSmokeInput(text=SMOKE_TEXT)
    )
    return result


@respx.mock
async def test_success_is_ok_with_status_latency_and_an_excerpt(
    laya_activities: LayaActivities,
) -> None:
    route = respx.post(SYSTEMONE_URL).respond(200, json=SUCCESS_BODY)
    result = await run_activity(laya_activities)
    assert result.ok is True
    assert result.status_code == 200
    assert result.latency_ms >= 0
    assert result.response_excerpt == "noul=0.8790"
    assert route.call_count == 1


@respx.mock
async def test_request_is_one_noul_question_over_the_given_text(
    laya_activities: LayaActivities,
) -> None:
    route = respx.post(SYSTEMONE_URL).respond(200, json=SUCCESS_BODY)
    await run_activity(laya_activities)
    request = route.calls.last.request
    assert request.headers["content-type"] == "application/json"
    body = json.loads(request.content)
    assert body["state"] == SMOKE_TEXT
    assert list(body["questions"]) == ["smoke"]
    assert body["questions"]["smoke"]["type"] == "noul"
    assert body["questions"]["smoke"]["instructions"]


@respx.mock
@pytest.mark.parametrize("status_code", [400, 413, 422, 500, 503])
async def test_an_http_error_is_ok_false_with_the_status(
    laya_activities: LayaActivities, status_code: int
) -> None:
    respx.post(SYSTEMONE_URL).respond(status_code, json={"error": "inference failed"})
    result = await run_activity(laya_activities)
    assert result.ok is False
    assert result.status_code == status_code
    assert result.response_excerpt is not None
    assert result.response_excerpt.startswith(f"HTTP {status_code}:")
    assert "inference failed" in result.response_excerpt


@respx.mock
async def test_a_long_error_body_is_truncated(laya_activities: LayaActivities) -> None:
    respx.post(SYSTEMONE_URL).respond(500, text="x" * 5000)
    result = await run_activity(laya_activities)
    assert result.response_excerpt is not None
    assert len(result.response_excerpt) == 200


@respx.mock
async def test_a_refused_connection_is_ok_false_without_a_status(
    laya_activities: LayaActivities,
) -> None:
    respx.post(SYSTEMONE_URL).mock(side_effect=httpx.ConnectError("connection refused"))
    result = await run_activity(laya_activities)
    assert result.ok is False
    assert result.status_code is None
    assert result.response_excerpt == "ConnectError: connection refused"


@respx.mock
async def test_an_httpx_timeout_is_ok_false(laya_activities: LayaActivities) -> None:
    respx.post(SYSTEMONE_URL).mock(side_effect=httpx.ReadTimeout("read timed out"))
    result = await run_activity(laya_activities)
    assert result.ok is False
    assert result.status_code is None
    assert result.response_excerpt is not None
    assert result.response_excerpt.startswith("ReadTimeout")


@pytest.mark.parametrize(
    "body",
    [
        {"answers": {}},
        {"answers": {"smoke": {"type": "noul"}}},
        {"answers": {"smoke": {"type": "noul", "noul": 1.7}}},
        {"answers": {"smoke": {"type": "noul", "noul": -0.1}}},
        {"answers": {"smoke": {"type": "noul", "noul": "high"}}},
        {"answers": {"smoke": {"type": "noul", "noul": True}}},
        {"answers": ["smoke"]},
        ["not", "an", "object"],
    ],
)
@respx.mock
async def test_a_200_without_a_valid_noul_answer_is_ok_false(
    laya_activities: LayaActivities, body: Any
) -> None:
    respx.post(SYSTEMONE_URL).respond(200, json=body)
    result = await run_activity(laya_activities)
    assert result.ok is False
    assert result.status_code == 200
    assert result.response_excerpt == "response has no noul answer in [0, 1]"


@respx.mock
async def test_a_200_with_a_body_that_is_not_json_is_ok_false(
    laya_activities: LayaActivities,
) -> None:
    respx.post(SYSTEMONE_URL).respond(200, text="<html>nope</html>")
    result = await run_activity(laya_activities)
    assert result.ok is False
    assert result.status_code == 200


async def test_a_response_slower_than_the_deadline_is_ok_false_not_an_exception() -> None:
    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200, json=SUCCESS_BODY)

    async with httpx.AsyncClient(transport=httpx.MockTransport(slow)) as client:
        result = await call_laya_smoke(client, TEST_LAYA_URL, SMOKE_TEXT, 0.2)
    assert result.ok is False
    assert result.status_code is None
    assert result.response_excerpt == "timed out after 0.2s"
    assert 150 <= result.latency_ms < 2000


@respx.mock
async def test_the_deadline_comes_from_the_worker_setting(
    worker_settings: WorkerSettings, http: httpx.AsyncClient
) -> None:
    seen: list[float] = []

    async def record_timeout(request: httpx.Request) -> httpx.Response:
        seen.append(request.extensions["timeout"]["read"])
        return httpx.Response(200, json=SUCCESS_BODY)

    respx.post(SYSTEMONE_URL).mock(side_effect=record_timeout)
    activities = LayaActivities(worker_settings, http)
    await run_activity(activities)
    assert seen == [float(worker_settings.laya_timeout_seconds)]
