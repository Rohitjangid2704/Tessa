import asyncio

import httpx
from pydantic import JsonValue

from tessa_api.schemas.enums import AdapterKind
from tessa_api.schemas.scenario import ScenarioStep, SseStep
from tessa_api.schemas.steps import SseClosedBy, SseEvent, SseStepResponse, StepTool
from tessa_worker.adapters.base import Adapter, StepRecord
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.http import decode_body, media_type
from tessa_worker.adapters.http_core import (
    Exchange,
    HttpFamilyAdapter,
    IdentitySession,
    OutgoingRequest,
    elapsed_ms,
    read_limited,
)
from tessa_worker.adapters.payload import fit_items, fit_text, json_size
from tessa_worker.adapters.redact import Redactor
from tessa_worker.adapters.sse_protocol import (
    ChatAggregator,
    SseMessage,
    SseParser,
    event_text,
)

EVENT_STREAM_TYPE = "text/event-stream"
STREAM_READ_FACTOR = 4
EVENT_OVERHEAD_BYTES = 48
ASK_KEYS = ("message", "ask", "question", "prompt", "text", "query")
SPAN_MARKER = "[redacted: a secret spans several events]"


def ask_from_body(body: JsonValue) -> str | None:
    if not isinstance(body, dict):
        return None
    for key in ASK_KEYS:
        value = body.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def event_size(event: SseEvent) -> int:
    return (
        len(event.data.encode("utf-8")) + len((event.event or "").encode()) + EVENT_OVERHEAD_BYTES
    )


class StreamCollector:
    def __init__(self, clock: float) -> None:
        self.clock = clock
        self.parser = SseParser()
        self.aggregator = ChatAggregator()
        self.events: list[SseEvent] = []
        self.raw_bytes = 0
        self.limit_reached = False

    async def consume(self, response: httpx.Response, limit: int) -> None:
        async for chunk in response.aiter_bytes():
            self.raw_bytes += len(chunk)
            self.accept(self.parser.feed(chunk))
            if self.raw_bytes >= limit:
                self.limit_reached = True
                return
        self.accept(self.parser.finish())

    def accept(self, messages: list[SseMessage]) -> None:
        at_ms = elapsed_ms(self.clock)
        for message in messages:
            self.events.append(SseEvent(event=message.event, data=message.data, at_ms=at_ms))
            self.aggregator.add(message)


class SseAdapter(HttpFamilyAdapter):
    kind = AdapterKind.sse
    default_accept = EVENT_STREAM_TYPE

    async def drive(self, step: ScenarioStep) -> StepRecord:
        if not isinstance(step, SseStep):
            raise TypeError(f"the sse adapter cannot drive a {step.adapter} step")
        ask = step.ask if step.ask is not None else ask_from_body(step.request.body)
        return await self.drive_request(step.request, step.label, ask, step.as_)

    async def exchange(
        self, session: IdentitySession, request: OutgoingRequest, clock: float
    ) -> Exchange:
        outgoing = self.build_request(session, request)
        collector = StreamCollector(clock)
        status: int | None = None
        timed_out = False
        try:
            async with asyncio.timeout(self.context.limits.step_timeout_seconds):
                response = await session.client.send(outgoing, stream=True)
                status = response.status_code
                try:
                    self.note_cookies(session)
                    if media_type(response.headers.get("content-type", "")) != EVENT_STREAM_TYPE:
                        return await self.plain_exchange(response, status, clock)
                    await collector.consume(response, self.read_budget(STREAM_READ_FACTOR))
                finally:
                    await response.aclose()
        except (TimeoutError, httpx.TimeoutException):
            if status is None:
                raise
            timed_out = True
        return self.conclude(status, collector, timed_out, elapsed_ms(clock))

    async def plain_exchange(self, response: httpx.Response, status: int, clock: float) -> Exchange:
        redactor = self.context.redactor
        raw, cut = await read_limited(response, self.read_budget())
        text = decode_body(raw, response.charset_encoding)
        redacted = redactor.redact_prefix(text) if cut else redactor.redact_text(text)
        fitted, fit_cut = fit_text(redacted, self.context.limits.max_payload_bytes)
        described = SseStepResponse.model_validate(
            {
                "kind": "sse",
                "status": status,
                "events": [],
                "closed_by": "server",
                "body_text": fitted or None,
            }
        )
        return Exchange(
            ok=True,
            response=described,
            truncated=cut or fit_cut,
            latency_ms=elapsed_ms(clock),
        )

    def conclude(
        self, status: int | None, collector: StreamCollector, timed_out: bool, latency_ms: int
    ) -> Exchange:
        redactor = self.context.redactor
        cap = self.context.limits.max_payload_bytes
        events = self.safe_events(collector.events, redactor)
        kept, events_cut = fit_items(events, event_size, cap)
        closed_by: SseClosedBy = "server"
        if timed_out:
            closed_by = "timeout"
        elif collector.limit_reached:
            closed_by = "limit"
        response = SseStepResponse(kind="sse", status=status or 0, events=kept, closed_by=closed_by)
        aggregator = collector.aggregator
        answer = aggregator.answer
        answer_cut = False
        if answer is not None:
            answer, answer_cut = fit_text(redactor.redact_text(answer), cap)
        tools, tools_cut = fit_items(
            [self.safe_tool(tool, redactor) for tool in aggregator.tools],
            lambda tool: json_size(tool.model_dump(mode="json")),
            cap,
        )
        cards, cards_cut = fit_items(
            [redactor.redact_object(card) for card in aggregator.cards], json_size, cap
        )
        seconds = self.context.limits.step_timeout_seconds
        return Exchange(
            ok=not timed_out,
            response=response,
            error=f"the stream did not end within {seconds:g}s" if timed_out else None,
            truncated=events_cut or answer_cut or tools_cut or cards_cut or collector.limit_reached,
            latency_ms=latency_ms,
            answer=answer,
            tools=tools,
            cards=cards,
            cost_usd=aggregator.cost_usd,
        )

    def safe_events(self, events: list[SseEvent], redactor: Redactor) -> list[SseEvent]:
        redacted = [
            SseEvent(
                event=redactor.redact_text(event.event) if event.event is not None else None,
                data=redactor.redact_text(event.data),
                at_ms=event.at_ms,
            )
            for event in events
        ]
        if redactor.contains_secret("".join(event_text(event.data) for event in redacted)):
            return [event.model_copy(update={"data": SPAN_MARKER}) for event in redacted]
        return redacted

    def safe_tool(self, tool: StepTool, redactor: Redactor) -> StepTool:
        summary = tool.result_summary
        return StepTool(
            name=redactor.redact_text(tool.name),
            args=redactor.redact_object(tool.args),
            result_summary=redactor.redact_text(summary) if summary is not None else None,
        )


async def open_sse_adapter(context: AdapterContext) -> Adapter:
    return SseAdapter(context)
