import jsonschema
from jsonschema.exceptions import SchemaError, ValidationError
from pydantic import JsonValue
from referencing.exceptions import Unresolvable

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.scenario import HttpExpect
from tessa_api.schemas.steps import HttpStepResponse, Tier0Failure
from tessa_worker.adapters.base import StepRecord
from tessa_worker.adapters.payload import json_text
from tessa_worker.checks.common import (
    SAMPLE_LIMIT,
    TRUNCATED_BODY_MESSAGE,
    adapter_failure,
    failure,
    in_check_order,
    json_list,
)
from tessa_worker.checks.contracts import Tier0Context
from tessa_worker.checks.fields import field_failures
from tessa_worker.checks.internal_ids import find_internal_ids


def accepted_statuses(declared: int | list[int]) -> list[int]:
    return declared if isinstance(declared, list) else [declared]


def status_failures(actual: int, declared: int | list[int] | None) -> list[Tier0Failure]:
    if declared is None:
        return []
    accepted = accepted_statuses(declared)
    if actual in accepted:
        return []
    message = f"the response status is {actual}"
    return [failure(Tier0Check.status, message, json_list(accepted), actual)]


def path_of(error: ValidationError) -> str:
    return "$" + "".join(
        f"[{part}]" if isinstance(part, int) else f".{part}" for part in error.absolute_path
    )


def schema_failures(
    record: StepRecord, response: HttpStepResponse, schema: dict[str, JsonValue]
) -> list[Tier0Failure]:
    if response.body is None and record.response_truncated:
        return [failure(Tier0Check.schema, TRUNCATED_BODY_MESSAGE)]
    if response.body_text is not None:
        return [
            failure(
                Tier0Check.schema,
                "the response body is not JSON, so it cannot be checked against the schema",
                "JSON body",
                "text body",
            )
        ]
    try:
        jsonschema.Draft202012Validator.check_schema(schema)
        errors = sorted(
            jsonschema.Draft202012Validator(schema).iter_errors(response.body),
            key=lambda error: [str(part) for part in error.absolute_path],
        )
    except SchemaError as error:
        return [failure(Tier0Check.schema, f"the expected schema is invalid: {error.message}")]
    except Unresolvable:
        return [
            failure(
                Tier0Check.schema, "the expected schema has a reference that cannot be resolved"
            )
        ]
    return [
        failure(
            Tier0Check.schema,
            f"{path_of(error)}: {error.message}",
            error.validator_value,
            error.instance,
        )
        for error in errors[:SAMPLE_LIMIT]
    ]


def body_failures(
    record: StepRecord, response: HttpStepResponse, expect: HttpExpect
) -> list[Tier0Failure]:
    failures: list[Tier0Failure] = []
    if expect.body_schema is not None:
        failures.extend(schema_failures(record, response, expect.body_schema))
    if expect.fields:
        if response.body is None and record.response_truncated:
            failures.append(failure(Tier0Check.fields, TRUNCATED_BODY_MESSAGE))
        elif response.body_text is not None:
            failures.append(
                failure(
                    Tier0Check.fields,
                    "the response body is not JSON, so its fields cannot be checked",
                    "JSON body",
                    "text body",
                )
            )
        else:
            for spec in expect.fields:
                failures.extend(field_failures(response.body, spec))
    return failures


def latency_failures(record: StepRecord, expect: HttpExpect) -> list[Tier0Failure]:
    if expect.latency is None or record.latency_ms <= expect.latency.max_ms:
        return []
    return [
        failure(
            Tier0Check.latency,
            f"the response took {record.latency_ms} ms",
            expect.latency.max_ms,
            record.latency_ms,
        )
    ]


def body_text_of(response: HttpStepResponse) -> str:
    if response.body_text is not None:
        return response.body_text
    if response.body is None:
        return ""
    return json_text(response.body)


def internal_id_failures(response: HttpStepResponse, context: Tier0Context) -> list[Tier0Failure]:
    found = find_internal_ids(body_text_of(response), context.internal_id_patterns)
    if not found:
        return []
    return [
        failure(
            Tier0Check.internal_ids,
            "the response body shows internal identifiers",
            "no internal identifiers",
            json_list(found),
        )
    ]


def http_failures(
    record: StepRecord, expect: HttpExpect, context: Tier0Context
) -> list[Tier0Failure]:
    failures = adapter_failure(record, Tier0Check.status)
    response = record.response
    if not isinstance(response, HttpStepResponse):
        return failures
    failures.extend(status_failures(response.status, expect.status))
    failures.extend(body_failures(record, response, expect))
    failures.extend(latency_failures(record, expect))
    if expect.internal_ids:
        failures.extend(internal_id_failures(response, context))
    return in_check_order(failures)
