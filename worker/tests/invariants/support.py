import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import JsonValue

from tessa_api.schemas.enums import (
    AdapterKind,
    AppKind,
    InvariantPack,
    ProbeEngine,
    ProbeStatus,
)
from tessa_api.schemas.grading import ProbeBatchResult
from tessa_api.schemas.oracles import GoldPoint
from tessa_api.schemas.probes import ProbeResult
from tessa_api.schemas.steps import (
    BrowserStepRequest,
    BrowserStepResponse,
    ConsoleMessage,
    HttpStepRequest,
    HttpStepResponse,
    SseEvent,
    SseStepRequest,
    SseStepResponse,
    StepRequestUnion,
    StepResponseUnion,
    StepTool,
    Tier0Result,
)
from tessa_api.schemas.temporal import RunLayaProbesInput
from tessa_worker.activities.grading_models import ProbePolarity
from tessa_worker.invariants.contracts import InvariantContext, InvariantStep

YES_NO = ProbePolarity(compliant_answer="yes", allowed_answers=["yes", "no"])
TARGET_URL = "http://target.test"
DEFAULT_ID_PATTERNS = (r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",)

ProbeAnswer = tuple[ProbeStatus, str | None, float]

COMPLIANT: ProbeAnswer = (ProbeStatus.decided, "yes", 0.9)
VIOLATED: ProbeAnswer = (ProbeStatus.decided, "no", 0.85)
UNSURE: ProbeAnswer = (ProbeStatus.uncertain, "yes", 0.4)
REFUSED: ProbeAnswer = (ProbeStatus.uncertain, None, 0.0)
UNREACHABLE: ProbeAnswer = (ProbeStatus.error, None, 0.0)


@dataclass
class ScriptedProbes:
    answers: dict[str, ProbeAnswer] = field(default_factory=dict)
    default: ProbeAnswer = UNREACHABLE
    asked: list[tuple[uuid.UUID, tuple[str, ...]]] = field(default_factory=list)

    async def run_laya_probes(self, request: RunLayaProbesInput) -> ProbeBatchResult:
        self.asked.append((request.step_id, tuple(request.probe_ids)))
        return ProbeBatchResult(results=[self.result(probe_id) for probe_id in request.probe_ids])

    def result(self, probe_id: str) -> ProbeResult:
        status, answer, confidence = self.answers.get(probe_id, self.default)
        return ProbeResult(
            id=uuid.uuid4(),
            probe_id=probe_id,
            pack=InvariantPack.generic,
            question="?",
            answer=answer,
            status=status,
            confidence=confidence,
            threshold=0.75,
            latency_ms=5,
            probe_bank_version="test",
            engine=ProbeEngine.laya,
        )


def http_request(
    path: str = "/api/items", method: str = "GET", headers: Mapping[str, str] | None = None
) -> HttpStepRequest:
    return HttpStepRequest(
        kind="http",
        method=method,
        url=f"{TARGET_URL}{path}",
        headers=dict(headers or {}),
        query=None,
        body=None,
    )


def http_response(
    status: int = 200, body: JsonValue = None, headers: Mapping[str, str] | None = None
) -> HttpStepResponse:
    return HttpStepResponse(
        kind="http", status=status, headers=dict(headers or {}), body=body, body_text=None
    )


def sse_request(path: str = "/api/chat") -> SseStepRequest:
    return SseStepRequest(
        kind="sse", method="POST", url=f"{TARGET_URL}{path}", headers={}, query=None, body=None
    )


def sse_response(first_event_ms: int = 10, data: str = "token") -> SseStepResponse:
    return SseStepResponse(
        kind="sse",
        status=200,
        events=[SseEvent(event=None, data=data, at_ms=first_event_ms)],
        closed_by="server",
    )


def browser_response(
    console: Sequence[tuple[str, str]] = (),
    text_excerpt: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> BrowserStepResponse:
    return BrowserStepResponse(
        kind="browser",
        url=f"{TARGET_URL}/page",
        title="Page",
        text_excerpt=text_excerpt,
        console=[ConsoleMessage(level=level, text=text) for level, text in console],
        dom_state=None,
        **dict(extra or {}),
    )


def browser_request() -> BrowserStepRequest:
    return BrowserStepRequest(
        kind="browser", action="navigate", target=None, text=None, url=f"{TARGET_URL}/page"
    )


def step(
    index: int = 0,
    request: StepRequestUnion | None = None,
    response: StepResponseUnion | None = None,
    adapter: AdapterKind = AdapterKind.http,
    ask: str | None = None,
    answer: str | None = None,
    latency_ms: int = 10,
    ok: bool | None = True,
    attempt: int = 0,
    tools: Sequence[str] = (),
    cards: Sequence[dict[str, JsonValue]] = (),
    gold_points: Sequence[GoldPoint] = (),
    oracle_row_counts: Mapping[uuid.UUID, int] | None = None,
) -> InvariantStep:
    return InvariantStep(
        step_id=uuid.uuid4(),
        index=index,
        attempt=attempt,
        adapter=adapter,
        label=f"step {index + 1}",
        ok=ok,
        request=request,
        response=response,
        ask=ask,
        answer=answer,
        tools=[StepTool(name=name, args={}, result_summary=None) for name in tools],
        cards=list(cards),
        latency_ms=latency_ms,
        tier0=Tier0Result(passed=True, failures=[]),
        gold_points=list(gold_points),
        db_checks=[],
        oracle_row_counts=dict(oracle_row_counts or {}),
    )


def http_step(
    index: int = 0,
    status: int = 200,
    body: JsonValue = None,
    path: str = "/api/items",
    method: str = "GET",
    request_headers: Mapping[str, str] | None = None,
    response_headers: Mapping[str, str] | None = None,
    **changes: Any,
) -> InvariantStep:
    return step(
        index,
        request=http_request(path, method, request_headers),
        response=http_response(status, body, response_headers),
        **changes,
    )


def chat_step(
    index: int = 0, ask: str = "Which issues are open?", answer: str = "", **changes: Any
) -> InvariantStep:
    return step(
        index,
        request=sse_request(),
        response=sse_response(),
        adapter=AdapterKind.sse,
        ask=ask,
        answer=answer,
        **changes,
    )


def gold(key: str, value: JsonValue, rendered: str) -> GoldPoint:
    return GoldPoint(key=key, value=value, oracle_result_id=uuid.uuid4(), rendered=rendered)


def context(
    steps: Sequence[InvariantStep],
    role: str = "staff",
    params: Mapping[str, JsonValue] | None = None,
    polarity: Mapping[str, ProbePolarity] | None = None,
    internal_id_patterns: tuple[str, ...] = DEFAULT_ID_PATTERNS,
    latency_default_ms: int = 3000,
) -> InvariantContext:
    return InvariantContext(
        run_id=uuid.uuid4(),
        run_scenario_id=uuid.uuid4(),
        scenario_id=uuid.uuid4(),
        attempt=0,
        feature_id="maintenance.read.open_issues",
        family="maintenance",
        role=role,
        interface_id="api",
        app_kind=AppKind.llm_assistant,
        read_only=False,
        steps=list(steps),
        params=dict(params or {}),
        latency_default_ms=latency_default_ms,
        internal_id_patterns=internal_id_patterns,
        probe_polarity=dict(polarity) if polarity is not None else {},
    )


def polarity_for(*probe_ids: str) -> dict[str, ProbePolarity]:
    return dict.fromkeys(probe_ids, YES_NO)
