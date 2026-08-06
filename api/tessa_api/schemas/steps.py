from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, RootModel

from tessa_api.schemas.artifacts import ArtifactRef
from tessa_api.schemas.common import Timestamp, Verdict
from tessa_api.schemas.enums import AdapterKind, Tier0Check
from tessa_api.schemas.grading import EvidenceBlock, JudgeResult
from tessa_api.schemas.oracles import DbCheck, GoldPoint
from tessa_api.schemas.probes import ProbeResult

BrowserRequestAction = Literal["navigate", "click", "type", "press", "wait", "read", "assert"]
SseClosedBy = Literal["server", "limit", "timeout"]
ElementState = Literal["visible", "hidden", "missing"]


class StepPayload(BaseModel):
    model_config = ConfigDict(extra="allow")


class HttpLikeStepRequest(StepPayload):
    method: str = Field(description="HTTP method as sent")
    url: str = Field(description="absolute URL as sent, secrets replaced by ${NAME} placeholders")
    headers: dict[str, str] = Field(description="request headers, secrets replaced by placeholders")
    query: dict[str, JsonValue] | None = Field(description="query parameters; null when none")
    body: JsonValue = Field(description="parsed JSON body; null when there is none")


class HttpStepRequest(HttpLikeStepRequest):
    kind: Literal["http"]


class SseStepRequest(HttpLikeStepRequest):
    kind: Literal["sse"]


class BrowserStepRequest(StepPayload):
    kind: Literal["browser"]
    action: BrowserRequestAction = Field(description="what the step did in the page")
    target: str | None = Field(description="element the action addressed, as text")
    text: str | None = Field(description="text typed or key pressed")
    url: str | None = Field(description="address opened by a navigate action")


class WebsocketMessage(BaseModel):
    at_ms: int = Field(ge=0, description="milliseconds since the connection was opened")
    data: str = Field(description="message text, secrets replaced by placeholders")


class WebsocketStepRequest(StepPayload):
    kind: Literal["websocket"]
    url: str = Field(description="ws or wss URL that was opened, without credentials in the query")
    messages_sent: list[WebsocketMessage] = Field(description="messages the step sent, in order")


class GraphqlStepRequest(StepPayload):
    kind: Literal["graphql"]
    url: str = Field(description="absolute URL of the GraphQL endpoint")
    operation_name: str | None = Field(description="operation to run when the document has several")
    query: str = Field(description="GraphQL document as sent")
    variables: dict[str, JsonValue] | None = Field(
        description="variables as sent, secrets replaced by placeholders; null when none"
    )


StepRequestUnion = Annotated[
    HttpStepRequest
    | SseStepRequest
    | BrowserStepRequest
    | WebsocketStepRequest
    | GraphqlStepRequest,
    Field(discriminator="kind"),
]


class StepRequest(RootModel[StepRequestUnion]):
    pass


class HttpStepResponse(StepPayload):
    kind: Literal["http"]
    status: int = Field(description="HTTP status code")
    headers: dict[str, str] = Field(description="response headers")
    body: JsonValue = Field(description="parsed body when the content type says JSON")
    body_text: str | None = Field(description="body as text when it is not JSON")


class SseEvent(BaseModel):
    event: str | None = Field(description="SSE event name; null for the default event")
    data: str = Field(description="event data as text")
    at_ms: int = Field(ge=0, description="milliseconds since the request was sent")


class SseStepResponse(StepPayload):
    kind: Literal["sse"]
    status: int = Field(description="HTTP status code of the stream response")
    events: list[SseEvent] = Field(description="events in arrival order")
    closed_by: SseClosedBy = Field(description="who ended the stream")


class ConsoleMessage(BaseModel):
    level: str = Field(description="console level such as error, warning, info or log")
    text: str = Field(description="message text")


class DomStateObservation(BaseModel):
    text_found: dict[str, bool] = Field(
        description="each text the step expected, mapped to whether the page shows it"
    )
    elements: dict[str, ElementState] = Field(
        description="each element the step expected, keyed by BrowserTarget.key(), to its state"
    )


class BrowserStepResponse(StepPayload):
    kind: Literal["browser"]
    url: str = Field(description="page address after the step")
    title: str | None = Field(description="page title after the step")
    text_excerpt: str | None = Field(description="visible text of the page, cut to a short excerpt")
    console: list[ConsoleMessage] = Field(description="console messages emitted during the step")
    dom_state: DomStateObservation | None = Field(
        description="observations of what the step expected from the page; null when none"
    )


class WebsocketStepResponse(StepPayload):
    kind: Literal["websocket"]
    messages_received: list[WebsocketMessage] = Field(
        description="messages that arrived, in order, up to TESSA_WS_ADAPTER_MAX_MESSAGES"
    )
    close_code: int | None = Field(
        description="close code of the connection; null when it was open"
    )
    close_reason: str | None = Field(description="close reason text; null when there is none")
    truncated: bool = Field(description="true when messages were dropped at the message cap")


class GraphqlError(BaseModel):
    message: str = Field(description="error message")
    path: list[str] | None = Field(description="response path of the failing field, as text")
    extensions: dict[str, JsonValue] | None = Field(description="error extensions; null when none")


class GraphqlStepResponse(StepPayload):
    kind: Literal["graphql"]
    status: int = Field(description="HTTP status code of the response")
    data: JsonValue = Field(description="data member of the response; null when absent")
    errors: list[GraphqlError] = Field(description="errors member of the response; empty when none")


StepResponseUnion = Annotated[
    HttpStepResponse
    | SseStepResponse
    | BrowserStepResponse
    | WebsocketStepResponse
    | GraphqlStepResponse,
    Field(discriminator="kind"),
]


class StepResponse(RootModel[StepResponseUnion]):
    pass


class StepTool(BaseModel):
    name: str = Field(description="tool the system under test called")
    args: dict[str, JsonValue] = Field(description="arguments of the call")
    result_summary: str | None = Field(description="short summary of the tool result")


class Tier0Failure(BaseModel):
    check: Tier0Check
    message: str = Field(description="what was wrong, in one sentence")
    expected: JsonValue = Field(description="what the check expected; null when not applicable")
    actual: JsonValue = Field(description="what was observed; null when not applicable")


class Tier0Result(BaseModel):
    passed: bool = Field(description="true when no check failed")
    failures: list[Tier0Failure]


class Step(BaseModel):
    id: UUID
    run_id: UUID
    run_scenario_id: UUID
    attempt: int = Field(ge=0, description="attempt number from 0")
    index: int = Field(ge=0, description="position of the step in the attempt from 0")
    adapter: AdapterKind
    label: str = Field(description="short description of the step")
    request: StepRequest | None = Field(description="what was sent; null when purged")
    response: StepResponse | None = Field(description="what came back; null when purged")
    response_truncated: bool = Field(description="true when the stored payload was cut")
    payload_purged: bool = Field(
        description="true when retention removed request, response and evidence, so a null "
        "payload is never mistaken for an empty one"
    )
    ask: str | None = Field(description="natural language input of a chat step")
    answer: str | None = Field(description="natural language answer of a chat step")
    tools: list[StepTool]
    cards: list[dict[str, JsonValue]]
    latency_ms: int = Field(ge=0)
    cost_usd: float = Field(ge=0)
    tier0: Tier0Result
    artifacts: list[ArtifactRef]
    verdict: Verdict | None = Field(description="grading verdict; null until graded")
    gold_points: list[GoldPoint] = Field(
        description="oracle derived expectations; empty before Stage 3"
    )
    db_checks: list[DbCheck] = Field(
        description="end state checks in the truth database; empty before Stage 3"
    )
    probes: list[ProbeResult] = Field(description="Laya probe results; empty before Stage 4")
    judge: JudgeResult | None = Field(
        description="judge result; null when the step was not escalated"
    )
    evidence: EvidenceBlock | None = Field(
        description="evidence block sent to the judge; null when the step was not escalated"
    )
    started_at: Timestamp
    finished_at: Timestamp


class StepSummary(BaseModel):
    id: UUID
    index: int = Field(ge=0)
    attempt: int = Field(ge=0)
    adapter: AdapterKind
    label: str
    ok: bool | None = Field(description="true when the adapter completed the step; null if unknown")
    latency_ms: int = Field(ge=0)
    cost_usd: float = Field(ge=0)
    tier0_failure_count: int = Field(ge=0)
    screenshot_count: int = Field(ge=0)
    verdict: Verdict | None = Field(description="grading verdict; null until graded")
