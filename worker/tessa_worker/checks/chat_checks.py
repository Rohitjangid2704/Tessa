from pydantic import JsonValue

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.scenario import (
    CardsExpect,
    EventsExpect,
    SseExpect,
    ToolMatch,
    ToolRef,
    ToolsExpect,
)
from tessa_api.schemas.steps import SseStepResponse, StepTool, Tier0Failure
from tessa_worker.adapters.base import StepRecord
from tessa_worker.checks.common import (
    adapter_failure,
    failure,
    in_check_order,
    json_equal,
    json_list,
    subset_match,
)
from tessa_worker.checks.contracts import Tier0Context
from tessa_worker.checks.http_checks import status_failures
from tessa_worker.checks.internal_ids import find_internal_ids

DEFAULT_EVENT_NAME = "message"


def tool_matches(tool: StepTool, reference: ToolRef) -> bool:
    if isinstance(reference, str):
        return tool.name == reference
    return tool.name == reference.name and all(
        name in tool.args and json_equal(tool.args[name], value)
        for name, value in reference.args.items()
    )


def describe_tool(reference: ToolRef) -> JsonValue:
    if isinstance(reference, ToolMatch):
        args: JsonValue = dict(reference.args)
        return {"name": reference.name, "args": args}
    return reference


def tool_failures(tools: list[StepTool], expect: ToolsExpect) -> list[Tier0Failure]:
    failures: list[Tier0Failure] = []
    called: list[JsonValue] = [tool.name for tool in tools]
    if expect.none and tools:
        failures.append(
            failure(Tier0Check.tools, "tools were called but none were expected", [], called)
        )
    if expect.at_least_one and not tools:
        failures.append(failure(Tier0Check.tools, "no tool was called", "at least one tool", []))
    if expect.max_calls is not None and len(tools) > expect.max_calls:
        failures.append(
            failure(
                Tier0Check.tools,
                f"{len(tools)} tools were called, at most {expect.max_calls} are accepted",
                expect.max_calls,
                len(tools),
            )
        )
    for reference in expect.include:
        if not any(tool_matches(tool, reference) for tool in tools):
            failures.append(
                failure(
                    Tier0Check.tools,
                    f"the expected tool call was not made: {describe_name(reference)}",
                    describe_tool(reference),
                    called,
                )
            )
    for reference in expect.exclude:
        if any(tool_matches(tool, reference) for tool in tools):
            failures.append(
                failure(
                    Tier0Check.tools,
                    f"a tool call that must not happen was made: {describe_name(reference)}",
                    describe_tool(reference),
                    called,
                )
            )
    return failures


def describe_name(reference: ToolRef) -> str:
    return reference if isinstance(reference, str) else reference.name


def card_failures(cards: list[dict[str, JsonValue]], expect: CardsExpect) -> list[Tier0Failure]:
    failures: list[Tier0Failure] = []
    if expect.min_count is not None and len(cards) < expect.min_count:
        failures.append(
            failure(
                Tier0Check.cards,
                f"{len(cards)} cards were shown, at least {expect.min_count} are expected",
                expect.min_count,
                len(cards),
            )
        )
    if expect.max_count is not None and len(cards) > expect.max_count:
        failures.append(
            failure(
                Tier0Check.cards,
                f"{len(cards)} cards were shown, at most {expect.max_count} are accepted",
                expect.max_count,
                len(cards),
            )
        )
    for wanted in expect.include:
        if not any(subset_match(card, wanted) for card in cards):
            failures.append(
                failure(Tier0Check.cards, "an expected card was not shown", wanted, len(cards))
            )
    return failures


def event_failures(
    response: SseStepResponse, expect: EventsExpect, truncated: bool
) -> list[Tier0Failure]:
    names = {event.event or DEFAULT_EVENT_NAME for event in response.events}
    seen = json_list(sorted(names))
    failures: list[Tier0Failure] = []
    for name in expect.include:
        if name not in names:
            message = f"the stream has no {name} event"
            failures.append(failure(Tier0Check.status, message, name, seen))
    for name in expect.exclude:
        if name in names:
            message = f"the stream has a {name} event that must not occur"
            failures.append(failure(Tier0Check.status, message, name, seen))
        elif truncated:
            message = f"the stream was cut, so the absence of a {name} event cannot be confirmed"
            failures.append(failure(Tier0Check.status, message, name, seen))
    return failures


def text_failures(answer: str | None, expect: SseExpect, truncated: bool) -> list[Tier0Failure]:
    failures: list[Tier0Failure] = []
    lowered = answer.lower() if answer is not None else None
    for text in expect.text_contains:
        if lowered is None:
            message = f"no answer to look for {text!r} in"
            failures.append(failure(Tier0Check.text_contains, message, text))
        elif text.lower() not in lowered:
            message = f"the answer does not contain {text!r}"
            failures.append(failure(Tier0Check.text_contains, message, text, answer))
    accepted_any = expect.text_contains_any
    if accepted_any and (
        lowered is None or not any(text.lower() in lowered for text in accepted_any)
    ):
        message = "the answer contains none of the accepted texts"
        failures.append(failure(Tier0Check.text_contains, message, json_list(accepted_any), answer))
    if expect.non_empty_answer and answer is not None and not answer.strip():
        message = "the answer is empty"
        failures.append(failure(Tier0Check.text_contains, message, "a non-empty answer", answer))
    if lowered is not None:
        for text in expect.text_not_contains:
            if text.lower() in lowered:
                message = f"the answer contains {text!r}, which must not appear"
                failures.append(failure(Tier0Check.text_not_contains, message, text, answer))
            elif truncated:
                message = f"the answer was cut, so the absence of {text!r} cannot be confirmed"
                failures.append(failure(Tier0Check.text_not_contains, message, text))
    return failures


def latency_failures(
    record: StepRecord, response: SseStepResponse, expect: SseExpect
) -> list[Tier0Failure]:
    latency = expect.latency
    if latency is None:
        return []
    failures: list[Tier0Failure] = []
    if latency.max_ms is not None and record.latency_ms > latency.max_ms:
        failures.append(
            failure(
                Tier0Check.latency,
                f"the stream took {record.latency_ms} ms in total",
                latency.max_ms,
                record.latency_ms,
            )
        )
    if latency.max_first_byte_ms is not None:
        first = response.events[0].at_ms if response.events else None
        if first is None:
            failures.append(
                failure(
                    Tier0Check.latency,
                    "the stream sent no event, so the first byte time is unknown",
                    latency.max_first_byte_ms,
                )
            )
        elif first > latency.max_first_byte_ms:
            failures.append(
                failure(
                    Tier0Check.latency,
                    f"the first event arrived after {first} ms",
                    latency.max_first_byte_ms,
                    first,
                )
            )
    return failures


def sse_failures(
    record: StepRecord, expect: SseExpect, context: Tier0Context
) -> list[Tier0Failure]:
    failures = adapter_failure(record, Tier0Check.status)
    response = record.response
    if not isinstance(response, SseStepResponse):
        return failures
    failures.extend(status_failures(response.status, expect.status))
    truncated = record.response_truncated
    if expect.events is not None:
        failures.extend(event_failures(response, expect.events, truncated))
    if expect.tools is not None:
        failures.extend(tool_failures(record.tools, expect.tools))
    if expect.cards is not None:
        failures.extend(card_failures(record.cards, expect.cards))
    failures.extend(text_failures(record.answer, expect, truncated))
    failures.extend(latency_failures(record, response, expect))
    if expect.internal_ids and record.answer is not None:
        found = find_internal_ids(record.answer, context.internal_id_patterns)
        if found:
            failures.append(
                failure(
                    Tier0Check.internal_ids,
                    "the answer shows internal identifiers",
                    "no internal identifiers",
                    json_list(found),
                )
            )
    return in_check_order(failures)
