import copy
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from tessa_api.schemas.bundle_files import (
    PARAM_SOURCES,
    Flow,
    FlowStep,
    FlowTarget,
    OracleSidecar,
)
from tests.bundle_examples import example_yaml
from tests.test_bundle_examples import definition_validator
from tests.test_bundle_schema import DELETE, mutate, published_schema


def oracle_document() -> dict[str, Any]:
    return copy.deepcopy(example_yaml("gracie", "oracle/open_maintenance.yaml"))


def flow_document() -> dict[str, Any]:
    return copy.deepcopy(example_yaml("gracie", "flows/create_maintenance_issue.yaml"))


def test_the_file_formats_are_defined_in_the_published_bundle_schema() -> None:
    definitions = published_schema()["$defs"]
    assert {
        "OracleSidecar",
        "OracleGoldPoint",
        "Flow",
        "FlowStep",
        "FlowTarget",
        "EnvTemplate",
    } <= set(definitions)
    assert set(definitions["OracleSidecar"]["required"]) == {
        "name",
        "feature_ids",
        "language",
        "params_schema",
        "sentence_template",
    }
    assert set(definitions["OracleSidecar"]["properties"]) == {
        "name",
        "feature_ids",
        "language",
        "params_schema",
        "sentence_template",
        "truth_source",
        "gold_points",
    }
    assert definitions["OracleSidecar"]["properties"]["language"]["enum"] == ["sql", "python"]
    assert set(definitions["Flow"]["required"]) == {"id", "title", "feature_ids", "role", "steps"}
    assert set(definitions["FlowStep"]["properties"]) == {
        "action",
        "url",
        "target",
        "value",
        "expect",
    }
    assert definitions["FlowStep"]["required"] == ["action"]
    assert definitions["EnvTemplate"]["type"] == "string"
    assert "NAME=value" in definitions["EnvTemplate"]["description"]


def test_the_oracle_sidecar_round_trips() -> None:
    sidecar = OracleSidecar.model_validate(oracle_document())
    assert sidecar.language == "sql"
    assert sidecar.model_dump(mode="json", exclude_none=True)["gold_points"][1] == {
        "key": "top_room",
        "expression": "rows[0].room",
    }


def test_the_optional_oracle_keys_default_to_absent() -> None:
    document = oracle_document()
    del document["truth_source"]
    del document["gold_points"]
    sidecar = OracleSidecar.model_validate(document)
    assert sidecar.truth_source is None
    assert sidecar.gold_points == []
    definition_validator("OracleSidecar").validate(document)


def test_unknown_keys_in_a_sidecar_are_kept() -> None:
    document = oracle_document() | {"owner": "guest-experience"}
    sidecar = OracleSidecar.model_validate(document)
    assert sidecar.model_extra == {"owner": "guest-experience"}
    definition_validator("OracleSidecar").validate(document)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (["name"], DELETE),
        (["name"], "has space"),
        (["feature_ids"], DELETE),
        (["feature_ids"], []),
        (["language"], "ruby"),
        (["language"], DELETE),
        (["params_schema"], DELETE),
        (["sentence_template"], DELETE),
        (["sentence_template"], ""),
        (["gold_points", 0, "key"], "Not Lower"),
        (["gold_points", 0, "expression"], DELETE),
    ],
)
def test_invalid_oracle_sidecars_are_rejected_by_both_validators(
    path: list[str | int], value: Any
) -> None:
    document = mutate(oracle_document(), path, value)
    assert not definition_validator("OracleSidecar").is_valid(document)
    with pytest.raises(ValidationError):
        OracleSidecar.model_validate(document)


@pytest.mark.parametrize(
    ("path", "value", "code"),
    [
        (["params_schema", "type"], "array", "params_schema_not_object"),
        (["params_schema", "properties"], ["tenant_id"], "params_schema_properties_invalid"),
        (
            ["params_schema", "properties", "today", "x-source"],
            "calendar",
            "unknown_param_source",
        ),
        (["params_schema", "required"], ["tenant_id", "ghost"], "required_param_not_declared"),
    ],
)
def test_the_params_schema_is_checked_beyond_its_shape(
    path: list[str | int], value: Any, code: str
) -> None:
    document = mutate(oracle_document(), path, value)
    with pytest.raises(ValidationError) as caught:
        OracleSidecar.model_validate(document)
    assert code in [error["type"] for error in caught.value.errors()]


@pytest.mark.parametrize("source", PARAM_SOURCES)
def test_every_documented_param_source_is_accepted(source: str) -> None:
    document = mutate(
        oracle_document(), ["params_schema", "properties", "today", "x-source"], source
    )
    OracleSidecar.model_validate(document)


def test_a_parameter_without_a_source_is_accepted() -> None:
    document = oracle_document()
    del document["params_schema"]["properties"]["today"]["x-source"]
    OracleSidecar.model_validate(document)


def test_the_flow_round_trips_and_keeps_unknown_keys() -> None:
    document = flow_document() | {"notes": "kept"}
    flow = Flow.model_validate(document)
    definition_validator("Flow").validate(document)
    assert flow.model_extra == {"notes": "kept"}
    assert len(flow.steps) == 7
    assert flow.steps[6].expect == {"text": ["Issue created"]}
    assert flow.steps[1].expect == {}


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (["id"], DELETE),
        (["id"], "has space"),
        (["title"], ""),
        (["feature_ids"], []),
        (["role"], DELETE),
        (["steps"], []),
        (["steps"], DELETE),
        (["steps", 0, "action"], "teleport"),
        (["steps", 0, "action"], DELETE),
        (["steps", 0, "expect"], "ok"),
    ],
)
def test_invalid_flows_are_rejected_by_both_validators(path: list[str | int], value: Any) -> None:
    document = mutate(flow_document(), path, value)
    assert not definition_validator("Flow").is_valid(document)
    with pytest.raises(ValidationError):
        Flow.model_validate(document)


@pytest.mark.parametrize(
    ("step", "code", "location"),
    [
        ({"action": "goto"}, "step_url_required", ("url",)),
        ({"action": "click"}, "step_target_required", ("target",)),
        ({"action": "hover"}, "step_target_required", ("target",)),
        (
            {"action": "fill", "target": {"selector": "#a"}},
            "step_value_required",
            ("value",),
        ),
        ({"action": "press"}, "step_value_required", ("value",)),
        (
            {"action": "select", "target": {"selector": "#a"}},
            "step_value_required",
            ("value",),
        ),
    ],
)
def test_a_step_needs_what_its_action_acts_on(
    step: dict[str, Any], code: str, location: tuple[str, ...]
) -> None:
    with pytest.raises(ValidationError) as caught:
        FlowStep.model_validate(step)
    assert [(error["type"], error["loc"]) for error in caught.value.errors()] == [(code, location)]


@pytest.mark.parametrize(
    "step",
    [
        {"action": "goto", "url": "/rooms"},
        {"action": "click", "target": {"role": "button", "name": "Save"}},
        {"action": "check", "target": {"selector": "[data-testid=agree]"}},
        {"action": "fill", "target": {"role": "textbox", "name": "Email"}, "value": "${EMAIL}"},
        {"action": "press", "value": "Enter"},
        {"action": "wait_for", "expect": {"text": ["Done"]}},
    ],
)
def test_steps_with_what_their_action_needs_are_valid(step: dict[str, Any]) -> None:
    FlowStep.model_validate(step)
    Draft202012Validator(
        {
            "$schema": published_schema()["$schema"],
            "$defs": published_schema()["$defs"],
            "$ref": "#/$defs/FlowStep",
        }
    ).validate(step)


@pytest.mark.parametrize(
    "target",
    [
        {},
        {"role": "button"},
        {"name": "Save"},
        {"role": "button", "name": "Save", "selector": "#save"},
        {"role": "button", "selector": "#save"},
    ],
)
def test_a_target_is_role_and_name_together_or_a_selector(target: dict[str, Any]) -> None:
    with pytest.raises(ValidationError) as caught:
        FlowTarget.model_validate(target)
    assert [error["type"] for error in caught.value.errors()] == ["target_ambiguous"]


@pytest.mark.parametrize(
    "target", [{"role": "button", "name": "Save"}, {"selector": "[data-testid=save]"}]
)
def test_a_target_in_either_form_is_valid(target: dict[str, Any]) -> None:
    assert FlowTarget.model_validate(target).model_dump(exclude_none=True) == target
