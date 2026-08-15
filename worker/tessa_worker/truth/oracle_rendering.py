from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from jinja2 import Undefined
from pydantic import JsonValue, ValidationError

from tessa_api.schemas.bundle_files import OracleGoldPoint
from tessa_api.schemas.oracles import GoldPoint
from tessa_api.services.gold_interpolation import text_of_value
from tessa_worker.truth.oracle_values import json_value
from tessa_worker.truth.sandbox import RenderError, evaluate_expression, render_template

Rows = Sequence[Mapping[str, JsonValue]]


def template_variables(rows: Rows, params: Mapping[str, JsonValue]) -> dict[str, Any]:
    return {"rows": [dict(row) for row in rows], "params": dict(params)}


def render_sentence(template_text: str, rows: Rows, params: Mapping[str, JsonValue]) -> str:
    return render_template(template_text, template_variables(rows, params)).strip()


def gold_value(expression: str, rows: Rows, params: Mapping[str, JsonValue]) -> JsonValue:
    value = evaluate_expression(expression, template_variables(rows, params))
    if isinstance(value, Undefined):
        raise RenderError("the expression evaluated to an undefined value")
    return json_value(value)


def gold_text(
    template_text: str | None, value: JsonValue, rows: Rows, params: Mapping[str, JsonValue]
) -> str:
    if template_text is None:
        return text_of_value(value)
    variables = {**template_variables(rows, params), "value": value}
    return render_template(template_text, variables).strip()


def parse_gold_definitions(definitions: Sequence[Mapping[str, Any]]) -> list[OracleGoldPoint]:
    try:
        return [OracleGoldPoint.model_validate(definition) for definition in definitions]
    except ValidationError as error:
        first = error.errors()[0]
        raise RenderError(f"a gold point definition is invalid: {first['msg']}") from None


def evaluate_gold_points(
    definitions: Sequence[Mapping[str, Any]],
    rows: Rows,
    params: Mapping[str, JsonValue],
    oracle_result_id: UUID,
) -> list[GoldPoint]:
    points: list[GoldPoint] = []
    for definition in parse_gold_definitions(definitions):
        try:
            value = gold_value(definition.expression, rows, params)
            rendered = gold_text(definition.template, value, rows, params)
        except RenderError as error:
            raise RenderError(f"gold point {definition.key!r}: {error.message}") from None
        points.append(
            GoldPoint(
                key=definition.key,
                value=value,
                oracle_result_id=oracle_result_id,
                rendered=rendered,
            )
        )
    return points
