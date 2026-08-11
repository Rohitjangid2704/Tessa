import json
from collections.abc import Callable
from copy import deepcopy
from typing import Any

import pytest
import yaml
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from tessa_api.schemas.scenario import (
    ANONYMOUS_IDENTITY,
    SCENARIO_SCHEMA_VERSION,
    BrowserTarget,
    HttpStep,
    ScenarioDoc,
    SseStep,
)
from tessa_api.services.schema_registry import build_scenario_schema
from tests.support import API_ROOT

FIXTURES = API_ROOT / "tests" / "fixtures" / "scenarios"
PUBLISHED_SCHEMA = API_ROOT.parent / "schemas" / "scenario.v1.json"
VALID_FIXTURES = sorted(path.stem for path in FIXTURES.glob("*.yaml"))

Mutator = Callable[[dict[str, Any]], None]


def load_yaml(name: str) -> dict[str, Any]:
    loaded = yaml.safe_load((FIXTURES / f"{name}.yaml").read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def load_golden(name: str) -> dict[str, Any]:
    golden = json.loads((FIXTURES / f"{name}.golden.json").read_text(encoding="utf-8"))
    assert isinstance(golden, dict)
    return golden


def dump(document: ScenarioDoc) -> dict[str, Any]:
    return document.model_dump(mode="json", by_alias=True)


def error_codes(caught: pytest.ExceptionInfo[ValidationError]) -> list[tuple[str, tuple[Any, ...]]]:
    return [(error["type"], tuple(error["loc"])) for error in caught.value.errors()]


@pytest.fixture(scope="module")
def schema_validator() -> Draft202012Validator:
    return Draft202012Validator(json.loads(PUBLISHED_SCHEMA.read_text(encoding="utf-8")))


def minimal_http() -> dict[str, Any]:
    return deepcopy(load_yaml("minimal_http"))


def minimal_browser() -> dict[str, Any]:
    return deepcopy(load_yaml("minimal_browser"))


def test_there_is_a_fixture_for_every_adapter_kind_and_the_captain_mappings() -> None:
    assert {
        "minimal_http",
        "minimal_sse",
        "minimal_browser",
        "full_http",
        "browser_login_chat",
        "captain_pet_policy",
        "captain_write_proposal",
    } <= set(VALID_FIXTURES)
    assert {path.stem.removesuffix(".golden") for path in FIXTURES.glob("*.golden.json")} == set(
        VALID_FIXTURES
    )


@pytest.mark.parametrize("name", VALID_FIXTURES)
def test_a_valid_scenario_normalises_to_its_golden_file(name: str) -> None:
    assert dump(ScenarioDoc.model_validate(load_yaml(name))) == load_golden(name)


@pytest.mark.parametrize("name", VALID_FIXTURES)
def test_the_normalised_form_validates_again_and_stays_equal(name: str) -> None:
    first = ScenarioDoc.model_validate(load_yaml(name))
    second = ScenarioDoc.model_validate(dump(first))
    assert second == first
    assert dump(second) == dump(first)


@pytest.mark.parametrize("name", VALID_FIXTURES)
def test_the_published_json_schema_accepts_every_valid_scenario(
    name: str, schema_validator: Draft202012Validator
) -> None:
    assert list(schema_validator.iter_errors(load_yaml(name))) == []


def test_the_committed_schema_is_the_one_the_models_generate() -> None:
    committed = json.loads(PUBLISHED_SCHEMA.read_text(encoding="utf-8"))
    generated = build_scenario_schema()
    assert committed["$defs"] == generated["$defs"]
    assert committed["properties"] == generated["properties"]
    assert committed["required"] == generated["required"]


def test_the_minimal_scenarios_have_one_step_of_their_own_kind() -> None:
    kinds = {
        name: [step["adapter"] for step in load_yaml(name)["steps"]]
        for name in ("minimal_http", "minimal_sse", "minimal_browser")
    }
    assert kinds == {
        "minimal_http": ["http"],
        "minimal_sse": ["sse"],
        "minimal_browser": ["browser"],
    }


def test_steps_resolve_to_the_model_of_their_adapter() -> None:
    document = ScenarioDoc.model_validate(load_yaml("captain_pet_policy"))
    assert all(isinstance(step, SseStep) for step in document.steps)
    document = ScenarioDoc.model_validate(load_yaml("full_http"))
    assert all(isinstance(step, HttpStep) for step in document.steps)


def test_schema_version_is_one_and_required() -> None:
    assert SCENARIO_SCHEMA_VERSION == 1
    missing = minimal_http()
    del missing["schema_version"]
    with pytest.raises(ValidationError):
        ScenarioDoc.model_validate(missing)
    other = minimal_http()
    other["schema_version"] = 2
    with pytest.raises(ValidationError):
        ScenarioDoc.model_validate(other)


def add_header_key(document: dict[str, Any]) -> None:
    document["priority"] = "high"


def add_step_key(document: dict[str, Any]) -> None:
    document["steps"][0]["retries"] = 3


def add_request_key(document: dict[str, Any]) -> None:
    document["steps"][0]["request"]["timeout"] = 5


def add_expect_key(document: dict[str, Any]) -> None:
    document["steps"][0]["expect"]["status_code"] = 200


def add_field_check_key(document: dict[str, Any]) -> None:
    document["steps"][0]["expect"]["fields"] = [{"path": "a", "exists": True, "contains": "x"}]


def add_latency_key(document: dict[str, Any]) -> None:
    document["steps"][0]["expect"]["latency"] = {"max_ms": 10, "p99": 3}


@pytest.mark.parametrize(
    "mutate",
    [
        add_header_key,
        add_step_key,
        add_request_key,
        add_expect_key,
        add_field_check_key,
        add_latency_key,
    ],
)
def test_unknown_keys_are_rejected_at_every_level(
    mutate: Mutator, schema_validator: Draft202012Validator
) -> None:
    document = minimal_http()
    mutate(document)
    with pytest.raises(ValidationError) as caught:
        ScenarioDoc.model_validate(document)
    assert {error["type"] for error in caught.value.errors()} == {"extra_forbidden"}
    assert list(schema_validator.iter_errors(document)) != []


def test_captain_only_keys_are_unknown_in_v1() -> None:
    for key in ("origin", "known_gap", "note", "clock", "turns"):
        document = minimal_http()
        document[key] = "x"
        with pytest.raises(ValidationError):
            ScenarioDoc.model_validate(document)


def test_the_header_accepts_the_reserved_header_keys() -> None:
    document = ScenarioDoc.model_validate(load_yaml("full_http"))
    assert document.id == "rooms-list-boundaries"
    assert document.cell is not None
    assert (document.cell.role, document.cell.interface_id) == ("admin", "admin_api")
    assert str(document.authored_from) == "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11"
    assert document.synthetic is False
    assert document.feature_id == "rooms.read.list"
    assert document.timeout_seconds == 120


def test_a_synthetic_scenario_needs_no_feature() -> None:
    document = minimal_http()
    document["synthetic"] = True
    document["family"] = "invariant"
    parsed = ScenarioDoc.model_validate(document)
    assert parsed.synthetic is True
    assert parsed.feature_id is None


def test_the_cell_must_equal_the_role_and_interface_of_the_header() -> None:
    document = minimal_http()
    document["cell"] = {"role": "staff", "interface_id": "admin_api"}
    with pytest.raises(ValidationError) as caught:
        ScenarioDoc.model_validate(document)
    assert error_codes(caught) == [("cell_mismatch", ("cell",))]


def test_a_step_may_run_as_anonymous_or_a_role() -> None:
    document = ScenarioDoc.model_validate(load_yaml("full_http"))
    assert [step.as_ for step in document.steps] == [None, ANONYMOUS_IDENTITY, "viewer"]
    assert [step["as"] for step in dump(document)["steps"]] == [None, "anonymous", "viewer"]


def test_as_is_written_as_as_not_as_underscore() -> None:
    assert "as_" not in json.dumps(dump(ScenarioDoc.model_validate(load_yaml("full_http"))))
    assert "as" in build_scenario_schema()["$defs"]["HttpStep"]["properties"]


def test_as_must_look_like_an_identity() -> None:
    document = minimal_http()
    document["steps"][0]["as"] = "not an identity"
    with pytest.raises(ValidationError):
        ScenarioDoc.model_validate(document)


def test_name_placeholders_are_accepted_in_paths_headers_bodies_and_browser_values() -> None:
    http = ScenarioDoc.model_validate(load_yaml("full_http"))
    first = http.steps[0]
    assert isinstance(first, HttpStep)
    assert first.request.headers["Authorization"] == "Bearer ${ADMIN_TOKEN}"
    third = http.steps[2]
    assert isinstance(third, HttpStep)
    assert third.request.path == "/api/rooms/${ROOM_ID}/notes"
    browser = ScenarioDoc.model_validate(load_yaml("browser_login_chat"))
    values = [getattr(step, "value", None) for step in browser.steps]
    assert "${STAFF_EMAIL}" in values
    assert "${STAFF_PASSWORD}" in values


def test_a_request_path_stays_below_the_interface_address() -> None:
    for path in ("//evil.example.com/x", "rooms", "http://evil.example.com/x", "/has space"):
        document = minimal_http()
        document["steps"][0]["request"]["path"] = path
        with pytest.raises(ValidationError):
            ScenarioDoc.model_validate(document)
    for path in ("/", "/api/rooms", "/api/rooms/${ROOM_ID}"):
        document = minimal_http()
        document["steps"][0]["request"]["path"] = path
        ScenarioDoc.model_validate(document)


def test_a_scenario_needs_at_least_one_step() -> None:
    document = minimal_http()
    document["steps"] = []
    with pytest.raises(ValidationError):
        ScenarioDoc.model_validate(document)


@pytest.mark.parametrize("adapter", ["webhook", "cli", "pipeline", "ingest", "smtp"])
def test_an_unknown_adapter_is_a_discriminator_error(adapter: str) -> None:
    document = minimal_http()
    document["steps"] = [{"adapter": adapter, "request": {"method": "POST", "path": "/hooks"}}]
    with pytest.raises(ValidationError) as caught:
        ScenarioDoc.model_validate(document)
    assert error_codes(caught) == [("union_tag_invalid", ("steps", 0))]


def test_the_http_status_can_be_one_code_or_a_list() -> None:
    document = minimal_http()
    document["steps"][0]["expect"]["status"] = [200, 204]
    parsed = ScenarioDoc.model_validate(document)
    assert isinstance(parsed.steps[0], HttpStep)
    assert parsed.steps[0].expect.status == [200, 204]
    document["steps"][0]["expect"]["status"] = 99
    with pytest.raises(ValidationError):
        ScenarioDoc.model_validate(document)


def test_a_field_check_needs_an_assertion_and_a_valid_path() -> None:
    for fields in ([{"path": "items"}], [{"path": "items..id", "exists": True}]):
        document = minimal_http()
        document["steps"][0]["expect"]["fields"] = fields
        with pytest.raises(ValidationError):
            ScenarioDoc.model_validate(document)
    for path in ("items", "items[0].id", "$.items[0]", "[0].id", "a.b-c.d_e"):
        document = minimal_http()
        document["steps"][0]["expect"]["fields"] = [{"path": path, "exists": True}]
        ScenarioDoc.model_validate(document)


def test_the_body_can_be_any_json_value() -> None:
    for body in (None, {"a": [1, 2, {"b": None}]}, [1, 2], "text", 3, True):
        document = minimal_http()
        document["steps"][0]["request"]["body"] = body
        parsed = ScenarioDoc.model_validate(document)
        assert isinstance(parsed.steps[0], HttpStep)
        assert parsed.steps[0].request.body == body


def test_the_sse_latency_needs_a_bound_and_the_tool_expectations_must_agree() -> None:
    document = ScenarioDoc.model_validate(load_yaml("minimal_sse")).model_dump(
        mode="json", by_alias=True
    )
    contradictions: tuple[dict[str, Any], ...] = (
        {"latency": {}},
        {"tools": {"none": True, "include": ["a"]}},
        {"tools": {"none": True, "at_least_one": True}},
        {"tools": {"none": True, "max_calls": 2}},
    )
    for expect in contradictions:
        broken = deepcopy(document)
        broken["steps"][0]["expect"] = expect
        with pytest.raises(ValidationError):
            ScenarioDoc.model_validate(broken)
    fine = deepcopy(document)
    fine["steps"][0]["expect"]["tools"] = {"none": True}
    ScenarioDoc.model_validate(fine)


def test_a_tool_can_be_a_bare_name_or_a_name_with_arguments() -> None:
    document = ScenarioDoc.model_validate(load_yaml("captain_write_proposal"))
    step = document.steps[0]
    assert isinstance(step, SseStep)
    assert step.expect.tools is not None
    assert step.expect.tools.exclude[0] == "propose_smart_log_entry"
    include = step.expect.tools.include[0]
    assert not isinstance(include, str)
    assert include.name == "propose_calendar_change"
    assert include.args == {"room": "10002"}


@pytest.mark.parametrize(
    ("step", "problem"),
    [
        ({"adapter": "browser", "action": "goto"}, "step_url_required"),
        ({"adapter": "browser", "action": "click"}, "step_target_required"),
        (
            {"adapter": "browser", "action": "fill", "target": {"selector": "#a"}},
            "step_value_required",
        ),
        ({"adapter": "browser", "action": "press"}, "step_value_required"),
        ({"adapter": "browser", "action": "wait_for"}, "step_expect_required"),
    ],
)
def test_a_browser_action_needs_what_it_acts_on(step: dict[str, Any], problem: str) -> None:
    document = minimal_browser()
    document["steps"] = [step]
    with pytest.raises(ValidationError) as caught:
        ScenarioDoc.model_validate(document)
    assert problem in {error["type"] for error in caught.value.errors()}


def test_a_browser_target_is_a_role_with_a_name_or_a_selector() -> None:
    assert BrowserTarget.model_validate({"role": "button", "name": "Send"}).key() == (
        "role=button name=Send"
    )
    assert BrowserTarget.model_validate({"selector": "[data-testid=x]"}).key() == (
        "selector=[data-testid=x]"
    )
    for target in (
        {"role": "button"},
        {"name": "Send"},
        {},
        {"role": "a", "name": "b", "selector": "c"},
    ):
        with pytest.raises(ValidationError):
            BrowserTarget.model_validate(target)


def test_page_state_and_console_expectations_need_content() -> None:
    document = minimal_browser()
    document["steps"][0]["expect"] = {"dom_state": {}}
    with pytest.raises(ValidationError):
        ScenarioDoc.model_validate(document)
    document["steps"][0]["expect"] = {"console": {"fail_on": []}}
    with pytest.raises(ValidationError):
        ScenarioDoc.model_validate(document)
    document["steps"][0]["expect"] = {"console": {"fail_on": ["info"]}}
    with pytest.raises(ValidationError):
        ScenarioDoc.model_validate(document)


def test_every_expectation_kind_can_carry_free_text() -> None:
    http = minimal_http()
    http["steps"][0]["expect"]["free_text"] = "A page of rooms"
    sse = deepcopy(load_yaml("minimal_sse"))
    sse["steps"][0]["expect"]["free_text"] = "Count of open items"
    browser = minimal_browser()
    browser["steps"][0]["expect"] = {"free_text": "The login form"}
    for document in (http, sse, browser):
        parsed = ScenarioDoc.model_validate(document)
        assert parsed.steps[0].expect.free_text is not None


def test_the_free_text_has_a_ceiling() -> None:
    document = minimal_http()
    document["steps"][0]["expect"]["free_text"] = "x" * 4001
    with pytest.raises(ValidationError):
        ScenarioDoc.model_validate(document)


def test_internal_ids_are_checked_unless_a_step_opts_out() -> None:
    document = ScenarioDoc.model_validate(load_yaml("full_http"))
    flags = [step.expect.internal_ids for step in document.steps if isinstance(step, HttpStep)]
    assert flags == [True, True, False]


def test_the_json_schema_is_valid_draft_2020_12_with_ui_hints_on_every_field() -> None:
    schema = build_scenario_schema()
    Draft202012Validator.check_schema(schema)
    nodes = [schema, *schema["$defs"].values()]
    for node in nodes:
        for name, property_schema in node.get("properties", {}).items():
            hints = property_schema["x-ui"]
            assert set(hints) == {"label", "group", "order", "widget"}, name
            assert hints["widget"] in {
                "text",
                "textarea",
                "select",
                "chips",
                "yaml",
                "number",
                "toggle",
            }
            assert property_schema["title"], name
            assert property_schema["description"], name
            assert property_schema["examples"], name


STEP_DEFINITIONS = ("HttpStep", "SseStep", "BrowserStep", "WebsocketStep", "GraphqlStep")


def test_the_json_schema_describes_every_step_kind() -> None:
    schema = build_scenario_schema()
    step = schema["properties"]["steps"]["items"]
    assert {ref["$ref"] for ref in step["oneOf"]} == {
        f"#/$defs/{definition}" for definition in STEP_DEFINITIONS
    }
    assert step["discriminator"]["propertyName"] == "adapter"
    for definition in STEP_DEFINITIONS:
        assert schema["$defs"][definition]["additionalProperties"] is False
    assert schema["additionalProperties"] is False


def test_the_json_schema_names_the_header_keys_the_plan_reserves() -> None:
    properties = build_scenario_schema()["properties"]
    assert {
        "schema_version",
        "id",
        "title",
        "feature_id",
        "family",
        "role",
        "interface_id",
        "timeout_seconds",
        "cell",
        "authored_from",
        "synthetic",
        "steps",
    } == set(properties)


def test_a_malformed_document_gets_validation_errors_in_both_validators(
    schema_validator: Draft202012Validator,
) -> None:
    document = minimal_http()
    document["steps"][0]["request"]["method"] = "FETCH"
    with pytest.raises(ValidationError):
        ScenarioDoc.model_validate(document)
    assert list(schema_validator.iter_errors(document)) != []


def test_an_sse_step_requires_a_non_empty_answer_unless_it_opts_out() -> None:
    document = deepcopy(load_yaml("minimal_sse"))
    parsed = ScenarioDoc.model_validate(document)
    assert isinstance(parsed.steps[0], SseStep)
    assert parsed.steps[0].expect.non_empty_answer is True
    document["steps"][0]["expect"]["non_empty_answer"] = False
    relaxed = ScenarioDoc.model_validate(document)
    assert isinstance(relaxed.steps[0], SseStep)
    assert relaxed.steps[0].expect.non_empty_answer is False
