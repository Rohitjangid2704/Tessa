from pydantic import JsonValue

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.scenario import GraphqlExpect
from tessa_api.schemas.steps import GraphqlStepResponse, Tier0Failure
from tessa_worker.adapters.base import StepRecord
from tessa_worker.adapters.payload import json_text
from tessa_worker.checks.common import (
    TRUNCATED_BODY_MESSAGE,
    adapter_failure,
    failure,
    in_check_order,
    json_list,
)
from tessa_worker.checks.contracts import Tier0Context
from tessa_worker.checks.fields import field_failures
from tessa_worker.checks.http_checks import status_failures
from tessa_worker.checks.internal_ids import find_internal_ids
from tessa_worker.checks.latency import max_latency_failures

DATA_TEXT_KEY = "data_text"
BODY_TEXT_KEY = "body_text"


def extra_value(response: GraphqlStepResponse, key: str) -> JsonValue:
    return (response.model_extra or {}).get(key)


def error_failures(response: GraphqlStepResponse, expect: GraphqlExpect) -> list[Tier0Failure]:
    messages = json_list(error.message for error in response.errors)
    failures: list[Tier0Failure] = []
    if expect.no_errors and response.errors:
        first = response.errors[0].message
        message = f"the response carries {len(response.errors)} GraphQL errors, the first: {first}"
        failures.append(failure(Tier0Check.status, message, "no errors", messages))
    joined = " ".join(error.message for error in response.errors).lower()
    for text in expect.error_contains:
        if text.lower() not in joined:
            message = f"the error messages do not contain {text!r}"
            failures.append(failure(Tier0Check.text_contains, message, text, messages))
    return failures


def response_body(response: GraphqlStepResponse) -> JsonValue:
    errors: list[JsonValue] = [
        error.model_dump(mode="json", exclude_none=True) for error in response.errors
    ]
    return {"data": response.data, "errors": errors}


def field_checks_failures(
    response: GraphqlStepResponse, expect: GraphqlExpect
) -> list[Tier0Failure]:
    if not expect.fields:
        return []
    if extra_value(response, DATA_TEXT_KEY) is not None:
        return [failure(Tier0Check.fields, TRUNCATED_BODY_MESSAGE)]
    if extra_value(response, BODY_TEXT_KEY) is not None:
        return [
            failure(
                Tier0Check.fields,
                "the response body is not a GraphQL JSON document, so its fields cannot be checked",
                "JSON body",
                "text body",
            )
        ]
    body = response_body(response)
    failures: list[Tier0Failure] = []
    for spec in expect.fields:
        failures.extend(field_failures(body, spec))
    return failures


def internal_id_failures(
    response: GraphqlStepResponse, context: Tier0Context
) -> list[Tier0Failure]:
    found = find_internal_ids(json_text(response.data), context.internal_id_patterns)
    if not found:
        return []
    return [
        failure(
            Tier0Check.internal_ids,
            "the response data shows internal identifiers",
            "no internal identifiers",
            json_list(found),
        )
    ]


def graphql_failures(
    record: StepRecord, expect: GraphqlExpect, context: Tier0Context
) -> list[Tier0Failure]:
    failures = adapter_failure(record, Tier0Check.status)
    response = record.response
    if not isinstance(response, GraphqlStepResponse):
        return failures
    failures.extend(status_failures(response.status, expect.status))
    failures.extend(error_failures(response, expect))
    failures.extend(field_checks_failures(response, expect))
    failures.extend(max_latency_failures(record, expect.latency, "the response"))
    if expect.internal_ids:
        failures.extend(internal_id_failures(response, context))
    return in_check_order(failures)
