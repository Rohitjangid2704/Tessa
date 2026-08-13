import re
from dataclasses import dataclass

from pydantic import JsonValue

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.scenario import FieldCheck, FieldType
from tessa_api.schemas.steps import Tier0Failure
from tessa_worker.checks.common import failure, json_equal

PATH_TOKEN = re.compile(r"\[(\d+)\]|([A-Za-z0-9_-]+)")


@dataclass(frozen=True)
class Resolution:
    value: JsonValue


def path_tokens(path: str) -> list[int | str]:
    stripped = path.removeprefix("$").removeprefix(".")
    tokens: list[int | str] = []
    for match in PATH_TOKEN.finditer(stripped):
        index, name = match.groups()
        tokens.append(int(index) if index is not None else name)
    return tokens


def resolve_path(body: JsonValue, path: str) -> Resolution | None:
    current = body
    for token in path_tokens(path):
        if isinstance(token, int):
            if not isinstance(current, list) or token >= len(current):
                return None
            current = current[token]
        else:
            if not isinstance(current, dict) or token not in current:
                return None
            current = current[token]
    return Resolution(current)


def has_type(value: JsonValue, expected: FieldType) -> bool:
    match expected:
        case "string":
            return isinstance(value, str)
        case "number":
            return isinstance(value, int | float) and not isinstance(value, bool)
        case "integer":
            return isinstance(value, int) and not isinstance(value, bool)
        case "boolean":
            return isinstance(value, bool)
        case "array":
            return isinstance(value, list)
        case "object":
            return isinstance(value, dict)
        case "null":
            return value is None


def length_of(value: JsonValue) -> int | None:
    if isinstance(value, str | list):
        return len(value)
    return None


def number_of(value: JsonValue) -> float | None:
    if isinstance(value, int | float) and not isinstance(value, bool):
        return float(value)
    return None


def field_failures(body: JsonValue, spec: FieldCheck) -> list[Tier0Failure]:
    resolution = resolve_path(body, spec.path)
    if resolution is None:
        if spec.exists is False:
            return []
        return [
            failure(
                Tier0Check.fields,
                f"{spec.path} is missing from the response body",
                expected="present",
                actual="missing",
            )
        ]
    value = resolution.value
    failures: list[Tier0Failure] = []
    path = spec.path

    def add(message: str, expected: JsonValue, actual: JsonValue) -> None:
        failures.append(failure(Tier0Check.fields, f"{path} {message}", expected, actual))

    if spec.exists is False:
        add("must not exist but is present", "absent", "present")
    if spec.equals is not None and not json_equal(value, spec.equals):
        add("does not equal the expected value", spec.equals, value)
    if spec.type is not None and not has_type(value, spec.type):
        add(f"is not of type {spec.type}", spec.type, type_name(value))
    if spec.matches is not None:
        failures.extend(matches_failures(path, value, spec.matches))
    failures.extend(length_failures(path, value, spec))
    failures.extend(range_failures(path, value, spec))
    return failures


def type_name(value: JsonValue) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def matches_failures(path: str, value: JsonValue, pattern: str) -> list[Tier0Failure]:
    if not isinstance(value, str):
        return [
            failure(
                Tier0Check.fields,
                f"{path} is not a string, so it cannot match {pattern}",
                pattern,
                type_name(value),
            )
        ]
    try:
        matched = re.search(pattern, value) is not None
    except re.error:
        return [failure(Tier0Check.fields, f"{path} is checked with an invalid pattern", pattern)]
    if matched:
        return []
    return [failure(Tier0Check.fields, f"{path} does not match {pattern}", pattern, value)]


def length_failures(path: str, value: JsonValue, spec: FieldCheck) -> list[Tier0Failure]:
    if spec.min_length is None and spec.max_length is None:
        return []
    length = length_of(value)
    if length is None:
        return [
            failure(
                Tier0Check.fields,
                f"{path} has no length because it is not a string or an array",
                "string or array",
                type_name(value),
            )
        ]
    failures: list[Tier0Failure] = []
    if spec.min_length is not None and length < spec.min_length:
        failures.append(
            failure(
                Tier0Check.fields,
                f"{path} is shorter than {spec.min_length}",
                spec.min_length,
                length,
            )
        )
    if spec.max_length is not None and length > spec.max_length:
        failures.append(
            failure(
                Tier0Check.fields,
                f"{path} is longer than {spec.max_length}",
                spec.max_length,
                length,
            )
        )
    return failures


def range_failures(path: str, value: JsonValue, spec: FieldCheck) -> list[Tier0Failure]:
    if spec.gte is None and spec.lte is None:
        return []
    number = number_of(value)
    if number is None:
        return [
            failure(
                Tier0Check.fields,
                f"{path} is not a number, so it cannot be compared",
                "number",
                type_name(value),
            )
        ]
    failures: list[Tier0Failure] = []
    if spec.gte is not None and number < spec.gte:
        failures.append(
            failure(Tier0Check.fields, f"{path} is below {spec.gte:g}", spec.gte, value)
        )
    if spec.lte is not None and number > spec.lte:
        failures.append(
            failure(Tier0Check.fields, f"{path} is above {spec.lte:g}", spec.lte, value)
        )
    return failures
