import pytest
from pydantic import JsonValue

from tessa_api.schemas.enums import Tier0Check
from tessa_worker.checks.tier0 import evaluate_tier0
from tests.checks.support import CONTEXT, checks_of, http_expect, http_record


@pytest.mark.parametrize(
    ("expected", "actual", "passes"),
    [
        (200, 200, True),
        (200, 201, False),
        (200, 404, False),
        (200, 500, False),
        ([200, 201], 201, True),
        ([200, 201], 200, True),
        ([200, 201], 202, False),
        ([404], 404, True),
        (None, 500, True),
        (None, 200, True),
    ],
)
def test_status_truth_table(expected: int | list[int] | None, actual: int, passes: bool) -> None:
    expect = http_expect(status=expected) if expected is not None else http_expect()
    result = evaluate_tier0(http_record(status=actual), expect, CONTEXT)
    assert result.passed is passes
    assert (Tier0Check.status in checks_of(result.failures)) is (not passes)


def test_a_status_failure_carries_expected_and_actual() -> None:
    result = evaluate_tier0(http_record(status=503), http_expect(status=[200, 204]), CONTEXT)
    [failure] = result.failures
    assert failure.check is Tier0Check.status
    assert failure.expected == [200, 204]
    assert failure.actual == 503
    assert "503" in failure.message


def test_a_step_the_adapter_could_not_complete_fails_the_status_check_with_its_reason() -> None:
    record = http_record(ok=False, error="timed out after 5s", with_response=False)
    for expect in (http_expect(), http_expect(status=200), http_expect(schema={"type": "object"})):
        result = evaluate_tier0(record, expect, CONTEXT)
        assert result.passed is False
        [failure] = result.failures
        assert failure.check is Tier0Check.status
        assert "timed out after 5s" in failure.message
        assert failure.actual == "timed out after 5s"


def test_an_unknown_outcome_is_not_an_adapter_failure() -> None:
    result = evaluate_tier0(http_record(ok=None), http_expect(status=200), CONTEXT)
    assert result.passed is True


OBJECT_SCHEMA: dict[str, JsonValue] = {
    "type": "object",
    "required": ["items", "total"],
    "properties": {"items": {"type": "array"}, "total": {"type": "integer"}},
}


@pytest.mark.parametrize(
    ("body", "passes"),
    [
        ({"items": [], "total": 0}, True),
        ({"items": [1], "total": 1, "extra": True}, True),
        ({"items": []}, False),
        ({"items": "no", "total": 0}, False),
        ({"items": [], "total": "0"}, False),
        ([], False),
        (None, False),
    ],
)
def test_schema_truth_table(body: JsonValue, passes: bool) -> None:
    result = evaluate_tier0(
        http_record(body=body), http_expect(schema=OBJECT_SCHEMA, internal_ids=False), CONTEXT
    )
    assert result.passed is passes
    assert (Tier0Check.schema in checks_of(result.failures)) is (not passes)


def test_a_schema_failure_names_the_json_path_and_the_rule() -> None:
    body: JsonValue = {"items": [], "total": "many"}
    [failure] = evaluate_tier0(
        http_record(body=body), http_expect(schema=OBJECT_SCHEMA), CONTEXT
    ).failures
    assert failure.check is Tier0Check.schema
    assert failure.message.startswith("$.total:")
    assert failure.expected == "integer"
    assert failure.actual == "many"


def test_nested_schema_paths_use_indexes() -> None:
    schema: dict[str, JsonValue] = {
        "type": "object",
        "properties": {"items": {"type": "array", "items": {"type": "object", "required": ["id"]}}},
    }
    body: JsonValue = {"items": [{"id": 1}, {"name": "x"}]}
    [failure] = evaluate_tier0(http_record(body=body), http_expect(schema=schema), CONTEXT).failures
    assert failure.message.startswith("$.items[1]:")


def test_at_most_five_schema_failures_are_reported_in_path_order() -> None:
    schema: dict[str, JsonValue] = {
        "type": "object",
        "properties": {f"f{index}": {"type": "string"} for index in range(9)},
    }
    body: JsonValue = {f"f{index}": index for index in range(9)}
    failures = evaluate_tier0(
        http_record(body=body), http_expect(schema=schema, internal_ids=False), CONTEXT
    ).failures
    assert len(failures) == 5
    assert [failure.message.split(":")[0] for failure in failures] == [
        "$.f0",
        "$.f1",
        "$.f2",
        "$.f3",
        "$.f4",
    ]


def test_a_text_body_cannot_be_checked_against_a_schema() -> None:
    [failure] = evaluate_tier0(
        http_record(body_text="plain"), http_expect(schema=OBJECT_SCHEMA), CONTEXT
    ).failures
    assert failure.check is Tier0Check.schema
    assert "not JSON" in failure.message


def test_a_truncated_body_cannot_be_checked_against_a_schema_or_fields() -> None:
    record = http_record(body=None, body_text='{"items":[', truncated=True)
    expect = http_expect(
        schema=OBJECT_SCHEMA, fields=[{"path": "total", "exists": True}], internal_ids=False
    )
    failures = evaluate_tier0(record, expect, CONTEXT).failures
    assert [failure.check for failure in failures] == [Tier0Check.schema, Tier0Check.fields]
    assert all("cut at the payload limit" in failure.message for failure in failures)


def test_an_invalid_schema_is_reported_not_raised() -> None:
    [failure] = evaluate_tier0(
        http_record(body={}),
        http_expect(schema={"type": "no-such-type"}, internal_ids=False),
        CONTEXT,
    ).failures
    assert failure.check is Tier0Check.schema
    assert "schema is invalid" in failure.message


def test_a_schema_with_an_unresolvable_reference_is_reported_not_raised() -> None:
    [failure] = evaluate_tier0(
        http_record(body={}),
        http_expect(schema={"$ref": "https://example.invalid/schema.json"}, internal_ids=False),
        CONTEXT,
    ).failures
    assert failure.check is Tier0Check.schema
    assert "cannot be resolved" in failure.message


BODY: JsonValue = {
    "total": 3,
    "name": "Rooms",
    "ratio": 0.5,
    "active": True,
    "none": None,
    "items": [{"id": "A-1", "tags": ["x", "y"]}, {"id": "B-2", "tags": []}],
    "nested": {"deep": {"value": 7}},
}


@pytest.mark.parametrize(
    ("check", "passes"),
    [
        ({"path": "total", "exists": True}, True),
        ({"path": "missing", "exists": True}, False),
        ({"path": "missing", "exists": False}, True),
        ({"path": "total", "exists": False}, False),
        ({"path": "$.total", "equals": 3}, True),
        ({"path": "total", "equals": 4}, False),
        ({"path": "name", "equals": "Rooms"}, True),
        ({"path": "name", "equals": "rooms"}, False),
        ({"path": "active", "equals": True}, True),
        ({"path": "active", "equals": 1}, False),
        ({"path": "total", "equals": True}, False),
        ({"path": "items[0].id", "equals": "A-1"}, True),
        ({"path": "items[1].id", "equals": "A-1"}, False),
        ({"path": "items[5].id", "exists": True}, False),
        ({"path": "items[5].id", "exists": False}, True),
        ({"path": "nested.deep.value", "equals": 7}, True),
        ({"path": "nested.deep.nope", "equals": 7}, False),
        ({"path": "items[0].tags", "equals": ["x", "y"]}, True),
        ({"path": "items[0].tags", "equals": ["y", "x"]}, False),
        ({"path": "nested", "equals": {"deep": {"value": 7}}}, True),
        ({"path": "nested", "equals": {"deep": {"value": 8}}}, False),
        ({"path": "name", "type": "string"}, True),
        ({"path": "name", "type": "number"}, False),
        ({"path": "total", "type": "integer"}, True),
        ({"path": "total", "type": "number"}, True),
        ({"path": "ratio", "type": "integer"}, False),
        ({"path": "ratio", "type": "number"}, True),
        ({"path": "active", "type": "boolean"}, True),
        ({"path": "active", "type": "integer"}, False),
        ({"path": "active", "type": "number"}, False),
        ({"path": "items", "type": "array"}, True),
        ({"path": "nested", "type": "object"}, True),
        ({"path": "nested", "type": "array"}, False),
        ({"path": "none", "type": "null"}, True),
        ({"path": "name", "type": "null"}, False),
        ({"path": "items[0].id", "matches": "^[A-Z]-\\d$"}, True),
        ({"path": "items[0].id", "matches": "^\\d+$"}, False),
        ({"path": "total", "matches": "3"}, False),
        ({"path": "name", "min_length": 5}, True),
        ({"path": "name", "min_length": 6}, False),
        ({"path": "name", "max_length": 5}, True),
        ({"path": "name", "max_length": 4}, False),
        ({"path": "items", "min_length": 2}, True),
        ({"path": "items", "min_length": 3}, False),
        ({"path": "items", "max_length": 2}, True),
        ({"path": "items", "max_length": 1}, False),
        ({"path": "total", "min_length": 1}, False),
        ({"path": "nested", "max_length": 5}, False),
        ({"path": "total", "gte": 3}, True),
        ({"path": "total", "gte": 4}, False),
        ({"path": "total", "lte": 3}, True),
        ({"path": "total", "lte": 2}, False),
        ({"path": "ratio", "gte": 0.5, "lte": 0.5}, True),
        ({"path": "ratio", "gte": 0.6}, False),
        ({"path": "active", "gte": 0}, False),
        ({"path": "name", "lte": 10}, False),
    ],
)
def test_fields_truth_table(check: dict[str, JsonValue], passes: bool) -> None:
    result = evaluate_tier0(
        http_record(body=BODY), http_expect(fields=[check], internal_ids=False), CONTEXT
    )
    assert result.passed is passes, result.failures
    assert set(checks_of(result.failures)) <= {Tier0Check.fields}


def test_every_failed_assertion_of_a_check_is_reported() -> None:
    check: dict[str, JsonValue] = {
        "path": "name",
        "equals": "Other",
        "type": "number",
        "max_length": 2,
    }
    failures = evaluate_tier0(
        http_record(body=BODY), http_expect(fields=[check], internal_ids=False), CONTEXT
    ).failures
    assert len(failures) == 3
    assert all(failure.check is Tier0Check.fields for failure in failures)


def test_a_missing_path_is_one_failure_with_expected_present() -> None:
    check: dict[str, JsonValue] = {"path": "nope.deeper", "equals": 1, "type": "integer"}
    [failure] = evaluate_tier0(
        http_record(body=BODY), http_expect(fields=[check], internal_ids=False), CONTEXT
    ).failures
    assert failure.expected == "present"
    assert failure.actual == "missing"


def test_an_invalid_field_pattern_is_reported_not_raised() -> None:
    check: dict[str, JsonValue] = {"path": "name", "matches": "("}
    [failure] = evaluate_tier0(
        http_record(body=BODY), http_expect(fields=[check], internal_ids=False), CONTEXT
    ).failures
    assert "invalid pattern" in failure.message


def test_field_checks_on_a_text_body_fail() -> None:
    [failure] = evaluate_tier0(
        http_record(body_text="<html>"),
        http_expect(fields=[{"path": "total", "exists": True}], internal_ids=False),
        CONTEXT,
    ).failures
    assert failure.check is Tier0Check.fields
    assert "not JSON" in failure.message


def test_field_paths_work_on_a_top_level_array() -> None:
    body: JsonValue = [{"id": 1}, {"id": 2}]
    result = evaluate_tier0(
        http_record(body=body),
        http_expect(
            fields=[{"path": "[1].id", "equals": 2}, {"path": "[0].id", "equals": 1}],
            internal_ids=False,
        ),
        CONTEXT,
    )
    assert result.passed is True


@pytest.mark.parametrize(
    ("max_ms", "latency", "passes"),
    [(100, 99, True), (100, 100, True), (100, 101, False), (1, 0, True), (500, 5000, False)],
)
def test_latency_truth_table(max_ms: int, latency: int, passes: bool) -> None:
    result = evaluate_tier0(
        http_record(latency_ms=latency), http_expect(latency={"max_ms": max_ms}), CONTEXT
    )
    assert result.passed is passes
    assert (Tier0Check.latency in checks_of(result.failures)) is (not passes)


def test_without_a_latency_expectation_any_latency_passes() -> None:
    assert evaluate_tier0(http_record(latency_ms=10**6), http_expect(), CONTEXT).passed is True


def test_a_latency_failure_carries_the_numbers() -> None:
    [failure] = evaluate_tier0(
        http_record(latency_ms=250), http_expect(latency={"max_ms": 200}), CONTEXT
    ).failures
    assert (failure.expected, failure.actual) == (200, 250)


@pytest.mark.parametrize(
    ("body", "passes"),
    [
        ({"name": "Rooms"}, True),
        ({"id": "3f2c9a52-0b1e-4f57-8f73-2d2a1b9c7e10"}, False),
        ({"id": "3F2C9A52-0B1E-4F57-8F73-2D2A1B9C7E10"}, False),
        ({"room_id": 4521}, False),
        ({"id": 17}, False),
        ({"items": [{"owner": {"id": 99}}]}, False),
        ({"room": 20003, "total": 8}, True),
        ({"date": "2026-10-05"}, True),
    ],
)
def test_internal_ids_in_a_json_body(body: JsonValue, passes: bool) -> None:
    result = evaluate_tier0(http_record(body=body), http_expect(), CONTEXT)
    assert result.passed is passes
    assert (Tier0Check.internal_ids in checks_of(result.failures)) is (not passes)


def test_internal_ids_in_a_text_body_and_when_switched_off() -> None:
    leaky = http_record(body_text="the user id: 4521")
    assert evaluate_tier0(leaky, http_expect(), CONTEXT).passed is False
    assert evaluate_tier0(leaky, http_expect(internal_ids=False), CONTEXT).passed is True


def test_an_internal_id_failure_lists_what_was_found() -> None:
    body: JsonValue = {"id": "3f2c9a52-0b1e-4f57-8f73-2d2a1b9c7e10", "room_id": 4521}
    [failure] = evaluate_tier0(http_record(body=body), http_expect(), CONTEXT).failures
    assert failure.check is Tier0Check.internal_ids
    assert isinstance(failure.actual, list)
    assert "3f2c9a52-0b1e-4f57-8f73-2d2a1b9c7e10" in failure.actual


def test_failures_come_in_check_order() -> None:
    body: JsonValue = {"id": "3f2c9a52-0b1e-4f57-8f73-2d2a1b9c7e10"}
    result = evaluate_tier0(
        http_record(status=500, body=body, latency_ms=900),
        http_expect(
            status=200,
            schema={"type": "array"},
            fields=[{"path": "name", "exists": True}],
            latency={"max_ms": 100},
        ),
        CONTEXT,
    )
    assert checks_of(result.failures) == [
        Tier0Check.status,
        Tier0Check.schema,
        Tier0Check.fields,
        Tier0Check.latency,
        Tier0Check.internal_ids,
    ]
