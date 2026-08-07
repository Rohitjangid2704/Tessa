from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, tzinfo
from typing import Any

from jsonschema import Draft202012Validator, SchemaError
from pydantic import JsonValue

from tessa_api.schemas.bundle_files import PARAM_SOURCE_KEY
from tessa_api.schemas.bundle_references import PLACEHOLDER_PATTERN
from tessa_api.services.gold_interpolation import iter_strings

CLOCK_SOURCE = "clock"
ROLE_SOURCE = "role"
LITERAL_SOURCE = "literal"
DEFAULT_KEY = "default"
FORMAT_KEY = "format"
REQUIRED_KEY = "required"
PROPERTIES_KEY = "properties"

Location = tuple[str | int, ...]


@dataclass(frozen=True, slots=True)
class ParamProblem:
    loc: Location
    code: str
    message: str


class ParameterSourceError(Exception):
    def __init__(self, problems: list[ParamProblem]) -> None:
        super().__init__("; ".join(problem.message for problem in problems))
        self.problems = problems


def schema_properties(schema: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    properties = schema.get(PROPERTIES_KEY)
    if not isinstance(properties, dict):
        return {}
    return {
        str(name): definition
        for name, definition in properties.items()
        if isinstance(definition, dict)
    }


def required_names(schema: Mapping[str, Any]) -> list[str]:
    required = schema.get(REQUIRED_KEY)
    return [str(name) for name in required] if isinstance(required, list) else []


def placeholder_names(params: Mapping[str, JsonValue]) -> list[str]:
    names: list[str] = []
    for text in iter_strings(dict(params)):
        names.extend(PLACEHOLDER_PATTERN.findall(text))
    return list(dict.fromkeys(names))


def placeholder_properties(params: Mapping[str, JsonValue]) -> frozenset[str]:
    return frozenset(
        name
        for name, value in params.items()
        if any(PLACEHOLDER_PATTERN.search(text) for text in iter_strings(value))
    )


def automatic_parameters(schema: Mapping[str, Any]) -> frozenset[str]:
    names: set[str] = set()
    for name, definition in schema_properties(schema).items():
        source = definition.get(PARAM_SOURCE_KEY)
        if source in (CLOCK_SOURCE, ROLE_SOURCE) or DEFAULT_KEY in definition:
            names.add(name)
    return frozenset(names)


def without_required(schema: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in schema.items() if key != REQUIRED_KEY}


def validate_oracle_params(
    schema: Mapping[str, Any],
    params: Mapping[str, JsonValue],
    supplied_later: frozenset[str] = frozenset(),
) -> list[ParamProblem]:
    try:
        Draft202012Validator.check_schema(dict(schema))
    except SchemaError as error:
        return [ParamProblem((), "params_schema_invalid", error.message)]
    deferred = placeholder_properties(params)
    problems = [
        ParamProblem((name,), "required", f"{name!r} is a required parameter")
        for name in required_names(schema)
        if name not in params and name not in supplied_later
    ]
    validator = Draft202012Validator(
        without_required(schema), format_checker=Draft202012Validator.FORMAT_CHECKER
    )
    for failure in sorted(validator.iter_errors(dict(params)), key=lambda item: list(item.path)):
        path: Location = tuple(failure.absolute_path)
        if path and path[0] in deferred:
            continue
        problems.append(ParamProblem(path, str(failure.validator), failure.message))
    return problems


def clock_value(definition: Mapping[str, Any], clock: datetime, zone: tzinfo) -> str:
    local = clock.astimezone(zone)
    match definition.get(FORMAT_KEY):
        case "date-time":
            return local.isoformat(timespec="seconds")
        case "time":
            return local.strftime("%H:%M:%S")
        case _:
            return local.date().isoformat()


def supplied_value(
    name: str,
    definition: Mapping[str, Any],
    clock: datetime | None,
    zone: tzinfo,
    role: str | None,
) -> JsonValue | ParamProblem | None:
    source = definition.get(PARAM_SOURCE_KEY)
    if source == CLOCK_SOURCE:
        if clock is None:
            return ParamProblem((name,), "clock_unavailable", f"{name!r} needs the run clock")
        return clock_value(definition, clock, zone)
    if source == ROLE_SOURCE:
        if role is None:
            return ParamProblem((name,), "role_unavailable", f"{name!r} needs the scenario role")
        return role
    if DEFAULT_KEY in definition:
        default: JsonValue = definition[DEFAULT_KEY]
        return default
    return None


def fill_parameter_sources(
    schema: Mapping[str, Any],
    params: Mapping[str, JsonValue],
    clock: datetime | None,
    zone: tzinfo,
    role: str | None,
) -> dict[str, JsonValue]:
    filled: dict[str, JsonValue] = dict(params)
    problems: list[ParamProblem] = []
    for name, definition in schema_properties(schema).items():
        if name in filled:
            continue
        value = supplied_value(name, definition, clock, zone, role)
        if isinstance(value, ParamProblem):
            problems.append(value)
        elif value is not None:
            filled[name] = value
    if problems:
        raise ParameterSourceError(problems)
    return filled
