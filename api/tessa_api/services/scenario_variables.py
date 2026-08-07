import re
from uuid import UUID

from pydantic import JsonValue

from tessa_api.schemas.scenario import ScenarioStep

RUN_MARKER_VARIABLE = "run_marker"
BUILT_IN_VARIABLES = frozenset({RUN_MARKER_VARIABLE})
BUILT_IN_PATTERN = re.compile(r"\{\{([a-z][a-z0-9_]*)\}\}")
RUN_MARKER_PATTERN = re.compile(r"\{\{" + RUN_MARKER_VARIABLE + r"\}\}")
MARKER_PREFIX = "rm"
MARKER_HEX_LENGTH = 12


def run_marker(run_id: UUID) -> str:
    return MARKER_PREFIX + run_id.hex[-MARKER_HEX_LENGTH:]


def built_in_names(text: str) -> list[str]:
    return BUILT_IN_PATTERN.findall(text)


def resolve_run_marker_text(text: str, marker: str) -> str:
    return RUN_MARKER_PATTERN.sub(lambda _: marker, text)


def resolve_run_marker(value: JsonValue, marker: str) -> JsonValue:
    if isinstance(value, str):
        return resolve_run_marker_text(value, marker)
    if isinstance(value, list):
        return [resolve_run_marker(item, marker) for item in value]
    if isinstance(value, dict):
        return {key: resolve_run_marker(item, marker) for key, item in value.items()}
    return value


def with_run_marker(step: ScenarioStep, run_id: UUID) -> ScenarioStep:
    document = step.model_dump(mode="json", by_alias=True, exclude_none=True)
    resolved = resolve_run_marker(document, run_marker(run_id))
    if resolved == document:
        return step
    return type(step).model_validate(resolved)
