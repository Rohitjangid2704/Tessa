from collections.abc import Iterable

from pydantic import JsonValue

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.steps import Tier0Failure
from tessa_worker.adapters.base import StepRecord
from tessa_worker.adapters.payload import json_text

SAMPLE_LIMIT = 5
BRIEF_LIMIT = 300
TRUNCATED_BODY_MESSAGE = (
    "the response body was cut at the payload limit, so this check cannot be evaluated"
)
CHECK_ORDER = {check: position for position, check in enumerate(Tier0Check)}


class Tier0MismatchError(ValueError):
    pass


def failure(
    check: Tier0Check, message: str, expected: JsonValue = None, actual: JsonValue = None
) -> Tier0Failure:
    return Tier0Failure(
        check=check, message=message, expected=brief(expected), actual=brief(actual)
    )


def json_list(values: Iterable[JsonValue]) -> list[JsonValue]:
    return list(values)


def brief(value: JsonValue) -> JsonValue:
    if value is None or isinstance(value, bool | int | float):
        return value
    text = value if isinstance(value, str) else json_text(value)
    if len(text) <= BRIEF_LIMIT:
        return value
    return text[:BRIEF_LIMIT] + "..."


def adapter_failure(record: StepRecord, check: Tier0Check) -> list[Tier0Failure]:
    if record.ok is not False:
        return []
    return [
        failure(
            check,
            f"the step did not complete: {record.error or 'no reason recorded'}",
            "a completed step",
            record.error,
        )
    ]


def in_check_order(failures: list[Tier0Failure]) -> list[Tier0Failure]:
    return sorted(failures, key=lambda item: CHECK_ORDER[item.check])


def json_equal(left: JsonValue, right: JsonValue) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            json_equal(left[key], right[key]) for key in left
        )
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            json_equal(a, b) for a, b in zip(left, right, strict=True)
        )
    if isinstance(left, dict | list) or isinstance(right, dict | list):
        return False
    return left == right


def subset_match(actual: JsonValue, wanted: JsonValue) -> bool:
    if isinstance(wanted, dict):
        return isinstance(actual, dict) and all(
            key in actual and subset_match(actual[key], value) for key, value in wanted.items()
        )
    return json_equal(actual, wanted)
