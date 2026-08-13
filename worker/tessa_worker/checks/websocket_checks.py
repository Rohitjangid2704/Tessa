import json
from dataclasses import dataclass

from pydantic import JsonValue

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.scenario import MessageFieldCheck, WebsocketExpect
from tessa_api.schemas.steps import Tier0Failure, WebsocketMessage, WebsocketStepResponse
from tessa_worker.adapters.base import StepRecord
from tessa_worker.adapters.ws_protocol import (
    ACCEPTED_CLOSE_CODES_BY_DEFAULT,
    CloseClass,
    classify_close,
    describe_close,
)
from tessa_worker.checks.common import adapter_failure, failure, in_check_order, json_list
from tessa_worker.checks.contracts import Tier0Context
from tessa_worker.checks.fields import field_failures
from tessa_worker.checks.internal_ids import find_internal_ids
from tessa_worker.checks.latency import stream_latency_failures

CLOSE_PROBLEMS = {
    CloseClass.policy_violation: "the server closed the connection for a policy violation",
    CloseClass.server_error: "the server closed the connection after an internal error",
    CloseClass.error: "the connection closed abnormally",
}
CUT_NOTE = " (the conversation was cut at a limit)"


@dataclass(frozen=True)
class ParsedMessage:
    value: JsonValue


def parse_message(message: WebsocketMessage) -> ParsedMessage | None:
    try:
        value: JsonValue = json.loads(message.data)
    except ValueError:
        return None
    return ParsedMessage(value)


def accepted_codes(expect: WebsocketExpect) -> list[int] | None:
    declared = expect.close_code
    if declared is None:
        return None
    return declared if isinstance(declared, list) else [declared]


def close_failures(response: WebsocketStepResponse, expect: WebsocketExpect) -> list[Tier0Failure]:
    code = response.close_code
    accepted = accepted_codes(expect)
    if accepted is None:
        if code is None or code in ACCEPTED_CLOSE_CODES_BY_DEFAULT:
            return []
        problem = CLOSE_PROBLEMS.get(classify_close(code), CLOSE_PROBLEMS[CloseClass.error])
        message = f"{problem}: {describe_close(code, response.close_reason)}"
        return [failure(Tier0Check.status, message, "1000, 1001 or still open", code)]
    if code in accepted:
        return []
    if code is None:
        message = "the connection was still open when listening ended"
    else:
        message = f"the connection closed with {describe_close(code, response.close_reason)}"
    return [failure(Tier0Check.status, message, json_list(accepted), code)]


def count_failures(response: WebsocketStepResponse, expect: WebsocketExpect) -> list[Tier0Failure]:
    count = len(response.messages_received)
    note = CUT_NOTE if response.truncated else ""
    failures: list[Tier0Failure] = []
    if expect.min_messages is not None and count < expect.min_messages:
        message = f"{count} messages arrived, at least {expect.min_messages} are expected{note}"
        failures.append(failure(Tier0Check.status, message, expect.min_messages, count))
    if expect.max_messages is not None:
        if count > expect.max_messages:
            message = f"{count} messages arrived, at most {expect.max_messages} are accepted"
            failures.append(failure(Tier0Check.status, message, expect.max_messages, count))
        elif response.truncated:
            message = (
                f"the conversation was cut, so at most {expect.max_messages} messages "
                "cannot be confirmed"
            )
            failures.append(failure(Tier0Check.status, message, expect.max_messages, count))
    return failures


def message_check_failures(
    parsed: list[ParsedMessage | None], spec: MessageFieldCheck, truncated: bool
) -> list[Tier0Failure]:
    if spec.message is not None:
        return indexed_check_failures(parsed, spec)
    readable = [item for item in parsed if item is not None]
    if not readable:
        return [
            failure(
                Tier0Check.fields,
                f"no received message is JSON, so {spec.path} cannot be checked",
                "a JSON message",
                f"{len(parsed)} messages",
            )
        ]
    attempts = [field_failures(item.value, spec) for item in readable]
    if any(not problems for problems in attempts):
        return []
    first = attempts[0][0]
    note = CUT_NOTE if truncated else ""
    return [
        failure(
            Tier0Check.fields,
            f"no received message satisfies the check on {spec.path}: {first.message}{note}",
            first.expected,
            first.actual,
        )
    ]


def indexed_check_failures(
    parsed: list[ParsedMessage | None], spec: MessageFieldCheck
) -> list[Tier0Failure]:
    index = spec.message
    if index is None or index >= len(parsed):
        return [
            failure(
                Tier0Check.fields,
                f"message {index} did not arrive, so {spec.path} cannot be checked",
                "a message",
                len(parsed),
            )
        ]
    item = parsed[index]
    if item is None:
        return [
            failure(
                Tier0Check.fields,
                f"message {index} is not JSON, so {spec.path} cannot be checked",
                "a JSON message",
                "a text message",
            )
        ]
    return field_failures(item.value, spec)


def field_checks_failures(
    response: WebsocketStepResponse, expect: WebsocketExpect
) -> list[Tier0Failure]:
    if not expect.fields:
        return []
    parsed = [parse_message(message) for message in response.messages_received]
    failures: list[Tier0Failure] = []
    for spec in expect.fields:
        failures.extend(message_check_failures(parsed, spec, response.truncated))
    return failures


def text_failures(response: WebsocketStepResponse, expect: WebsocketExpect) -> list[Tier0Failure]:
    joined = "\n".join(message.data for message in response.messages_received)
    lowered = joined.lower()
    failures: list[Tier0Failure] = []
    for text in expect.text_contains:
        if text.lower() not in lowered:
            message = f"the messages do not contain {text!r}"
            failures.append(failure(Tier0Check.text_contains, message, text, joined))
    for text in expect.text_not_contains:
        if text.lower() in lowered:
            message = f"the messages contain {text!r}, which must not appear"
            failures.append(failure(Tier0Check.text_not_contains, message, text, joined))
        elif response.truncated:
            message = f"the conversation was cut, so the absence of {text!r} cannot be confirmed"
            failures.append(failure(Tier0Check.text_not_contains, message, text))
    return failures


def websocket_failures(
    record: StepRecord, expect: WebsocketExpect, context: Tier0Context
) -> list[Tier0Failure]:
    failures = adapter_failure(record, Tier0Check.status)
    response = record.response
    if not isinstance(response, WebsocketStepResponse):
        return failures
    failures.extend(close_failures(response, expect))
    failures.extend(count_failures(response, expect))
    failures.extend(field_checks_failures(response, expect))
    failures.extend(text_failures(response, expect))
    first = response.messages_received[0].at_ms if response.messages_received else None
    failures.extend(
        stream_latency_failures(record, expect.latency, first, "the conversation", "message")
    )
    if expect.internal_ids:
        joined = "\n".join(message.data for message in response.messages_received)
        found = find_internal_ids(joined, context.internal_id_patterns)
        if found:
            failures.append(
                failure(
                    Tier0Check.internal_ids,
                    "the messages show internal identifiers",
                    "no internal identifiers",
                    json_list(found),
                )
            )
    return in_check_order(failures)
