from datetime import UTC, datetime
from typing import Any

from pydantic import JsonValue

from tessa_api.schemas.enums import AdapterKind, Tier0Check
from tessa_api.schemas.scenario import BrowserExpect, HttpExpect, SseExpect
from tessa_api.schemas.steps import (
    BrowserStepRequest,
    BrowserStepResponse,
    ConsoleMessage,
    DomStateObservation,
    HttpStepRequest,
    HttpStepResponse,
    SseEvent,
    SseStepRequest,
    SseStepResponse,
    StepTool,
    Tier0Failure,
)
from tessa_worker.adapters.base import StepRecord
from tessa_worker.checks.contracts import Tier0Context
from tessa_worker.checks.internal_ids import DEFAULT_INTERNAL_ID_PATTERNS

NOW = datetime(2026, 10, 5, 9, 0, 0, tzinfo=UTC)
CONTEXT = Tier0Context(internal_id_patterns=DEFAULT_INTERNAL_ID_PATTERNS)


def http_expect(**fields: Any) -> HttpExpect:
    return HttpExpect.model_validate(fields)


def sse_expect(**fields: Any) -> SseExpect:
    return SseExpect.model_validate(fields)


def browser_expect(**fields: Any) -> BrowserExpect:
    return BrowserExpect.model_validate(fields)


def http_record(
    status: int = 200,
    body: JsonValue = None,
    body_text: str | None = None,
    latency_ms: int = 10,
    ok: bool | None = True,
    error: str | None = None,
    truncated: bool = False,
    with_response: bool = True,
) -> StepRecord:
    response = (
        HttpStepResponse(kind="http", status=status, headers={}, body=body, body_text=body_text)
        if with_response
        else None
    )
    return StepRecord(
        adapter=AdapterKind.http,
        label="GET /x",
        request=HttpStepRequest(
            kind="http", method="GET", url="http://t/x", headers={}, query=None, body=None
        ),
        response=response,
        response_truncated=truncated,
        ok=ok,
        error=error,
        latency_ms=latency_ms,
        started_at=NOW,
        finished_at=NOW,
    )


def sse_record(
    answer: str | None = "an answer",
    tools: list[tuple[str, dict[str, JsonValue]]] | None = None,
    cards: list[dict[str, JsonValue]] | None = None,
    events: list[tuple[str | None, int]] | None = None,
    status: int = 200,
    latency_ms: int = 100,
    ok: bool | None = True,
    error: str | None = None,
    truncated: bool = False,
    with_response: bool = True,
) -> StepRecord:
    declared = events if events is not None else [("token", 5), ("done", 9)]
    response = (
        SseStepResponse(
            kind="sse",
            status=status,
            events=[SseEvent(event=name, data="{}", at_ms=at) for name, at in declared],
            closed_by="server",
        )
        if with_response
        else None
    )
    return StepRecord(
        adapter=AdapterKind.sse,
        label="POST /message",
        request=SseStepRequest(
            kind="sse", method="POST", url="http://t/m", headers={}, query=None, body=None
        ),
        response=response,
        response_truncated=truncated,
        ok=ok,
        error=error,
        answer=answer,
        tools=[StepTool(name=name, args=args, result_summary=None) for name, args in tools or []],
        cards=cards or [],
        latency_ms=latency_ms,
        started_at=NOW,
        finished_at=NOW,
    )


def browser_record(
    url: str = "http://t/chat",
    title: str | None = "Chat",
    text_found: dict[str, bool] | None = None,
    elements: dict[str, str] | None = None,
    console: list[tuple[str, str]] | None = None,
    observed: bool = True,
    ok: bool | None = True,
    error: str | None = None,
    with_response: bool = True,
) -> StepRecord:
    observation = (
        DomStateObservation.model_validate(
            {"text_found": text_found or {}, "elements": elements or {}}
        )
        if observed
        else None
    )
    response = (
        BrowserStepResponse(
            kind="browser",
            url=url,
            title=title,
            text_excerpt=None,
            console=[ConsoleMessage(level=level, text=text) for level, text in console or []],
            dom_state=observation,
        )
        if with_response
        else None
    )
    return StepRecord(
        adapter=AdapterKind.browser,
        label="click Send",
        request=BrowserStepRequest(
            kind="browser", action="click", target="button Send", text=None, url=None
        ),
        response=response,
        ok=ok,
        error=error,
        latency_ms=5,
        started_at=NOW,
        finished_at=NOW,
    )


def checks_of(failures: list[Tier0Failure]) -> list[Tier0Check]:
    return [failure.check for failure in failures]
