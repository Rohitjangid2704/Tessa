import asyncio
import time
from typing import Any

import httpx
from temporalio import activity

from tessa_api.schemas.hello import LayaSmokeInput, LayaSmokeResult
from tessa_worker.activities.names import LAYA_SMOKE_CALL
from tessa_worker.settings import WorkerSettings

SYSTEMONE_PATH = "/v1/systemone"
SMOKE_QUESTION_ID = "smoke"
SMOKE_QUESTION = {
    "type": "noul",
    "instructions": "Is this text a greeting or a short status message?",
}
EXCERPT_LIMIT = 200


def smoke_request_body(text: str) -> dict[str, Any]:
    return {"state": text, "questions": {SMOKE_QUESTION_ID: SMOKE_QUESTION}}


def elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


def failed(started: float, status_code: int | None, reason: str) -> LayaSmokeResult:
    return LayaSmokeResult(
        ok=False,
        latency_ms=elapsed_ms(started),
        status_code=status_code,
        response_excerpt=reason[:EXCERPT_LIMIT],
    )


def read_noul_answer(response: httpx.Response) -> float | None:
    try:
        answer = response.json()["answers"][SMOKE_QUESTION_ID]["noul"]
    except (ValueError, KeyError, TypeError):
        return None
    if isinstance(answer, bool) or not isinstance(answer, int | float):
        return None
    if not 0.0 <= answer <= 1.0:
        return None
    return float(answer)


async def call_laya_smoke(
    http: httpx.AsyncClient, laya_url: str, text: str, timeout_seconds: float
) -> LayaSmokeResult:
    started = time.perf_counter()
    try:
        async with asyncio.timeout(timeout_seconds):
            response = await http.post(
                f"{laya_url}{SYSTEMONE_PATH}",
                json=smoke_request_body(text),
                timeout=timeout_seconds,
            )
    except TimeoutError:
        return failed(started, None, f"timed out after {timeout_seconds:g}s")
    except httpx.HTTPError as error:
        return failed(started, None, f"{type(error).__name__}: {error}")
    latency_ms = elapsed_ms(started)
    if response.status_code != 200:
        return failed(
            started, response.status_code, f"HTTP {response.status_code}: {response.text}"
        )
    noul = read_noul_answer(response)
    if noul is None:
        return failed(started, response.status_code, "response has no noul answer in [0, 1]")
    return LayaSmokeResult(
        ok=True,
        latency_ms=latency_ms,
        status_code=response.status_code,
        response_excerpt=f"noul={noul:.4f}",
    )


class LayaActivities:
    def __init__(self, settings: WorkerSettings, http: httpx.AsyncClient) -> None:
        self.settings = settings
        self.http = http

    @activity.defn(name=LAYA_SMOKE_CALL)
    async def laya_smoke_call(self, request: LayaSmokeInput) -> LayaSmokeResult:
        return await call_laya_smoke(
            self.http,
            self.settings.laya_url,
            request.text,
            float(self.settings.laya_timeout_seconds),
        )
