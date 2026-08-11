from typing import Any

import pytest
from pydantic import ValidationError

from tessa_api.openapi_export import build_openapi_document
from tessa_api.schemas.plans import PlanSelection
from tessa_api.schemas.runs import RunCreate
from tests.test_openapi import BEARER_OR_SERVICE_KEY_OPERATIONS

STAGE_TWO_OPERATIONS = {
    ("post", "/api/v1/plans/preview"),
    ("post", "/api/v1/plans"),
    ("get", "/api/v1/plans"),
    ("get", "/api/v1/plans/{plan_id}"),
    ("patch", "/api/v1/plans/{plan_id}"),
    ("delete", "/api/v1/plans/{plan_id}"),
    ("get", "/api/v1/plans/{plan_id}/cells"),
    ("get", "/api/v1/scenarios"),
    ("get", "/api/v1/scenarios/{scenario_id}"),
    ("post", "/api/v1/runs"),
    ("get", "/api/v1/runs"),
    ("get", "/api/v1/runs/{run_id}"),
    ("post", "/api/v1/runs/{run_id}/cancel"),
    ("get", "/api/v1/runs/{run_id}/scenarios"),
    ("get", "/api/v1/runs/{run_id}/browser-sessions"),
    ("get", "/api/v1/run-scenarios/{run_scenario_id}"),
    ("get", "/api/v1/steps/{step_id}"),
    ("get", "/api/v1/artifacts/{token}"),
    ("get", "/api/v1/feeds/runs"),
}

STAGE_TWO_SCHEMAS = {
    "ArtifactRef",
    "Budget",
    "BudgetState",
    "BrowserSession",
    "BrowserSessionList",
    "CoverageCell",
    "CoverageCellPage",
    "Plan",
    "PlanCreate",
    "PlanPage",
    "PlanPreview",
    "PlanSelection",
    "PlanUpdate",
    "Run",
    "RunConfigSnapshot",
    "RunCreate",
    "RunHandle",
    "RunScenario",
    "RunScenarioPage",
    "RunScenarioSummary",
    "RunSummary",
    "RunSummaryPage",
    "Scenario",
    "ScenarioSummary",
    "ScenarioSummaryPage",
    "ScenarioValidation",
    "Step",
    "StepRequest",
    "StepResponse",
    "StepSummary",
    "Tier0Result",
    "Verdict",
}

RESPONSE_MODELS = {
    ("post", "/api/v1/plans/preview"): ("200", "PlanPreview"),
    ("post", "/api/v1/plans"): ("201", "Plan"),
    ("get", "/api/v1/plans"): ("200", "PlanPage"),
    ("get", "/api/v1/plans/{plan_id}"): ("200", "Plan"),
    ("patch", "/api/v1/plans/{plan_id}"): ("200", "Plan"),
    ("get", "/api/v1/plans/{plan_id}/cells"): ("200", "CoverageCellPage"),
    ("get", "/api/v1/scenarios"): ("200", "ScenarioSummaryPage"),
    ("get", "/api/v1/scenarios/{scenario_id}"): ("200", "Scenario"),
    ("post", "/api/v1/runs"): ("202", "RunHandle"),
    ("get", "/api/v1/runs"): ("200", "RunSummaryPage"),
    ("get", "/api/v1/runs/{run_id}"): ("200", "Run"),
    ("post", "/api/v1/runs/{run_id}/cancel"): ("202", "Run"),
    ("get", "/api/v1/runs/{run_id}/scenarios"): ("200", "RunScenarioPage"),
    ("get", "/api/v1/runs/{run_id}/browser-sessions"): ("200", "BrowserSessionList"),
    ("get", "/api/v1/run-scenarios/{run_scenario_id}"): ("200", "RunScenario"),
    ("get", "/api/v1/steps/{step_id}"): ("200", "Step"),
}

REQUEST_MODELS = {
    ("post", "/api/v1/plans/preview"): "PlanCreate",
    ("post", "/api/v1/plans"): "PlanCreate",
    ("patch", "/api/v1/plans/{plan_id}"): "PlanUpdate",
    ("post", "/api/v1/runs"): "RunCreate",
}

PAGED_OPERATIONS = {
    ("get", "/api/v1/plans"): ("-created_at", ["created_at"]),
    ("get", "/api/v1/plans/{plan_id}/cells"): (
        "feature_id,role,interface_id",
        ["feature_id", "role", "interface_id", "status"],
    ),
    ("get", "/api/v1/scenarios"): ("-created_at", ["created_at", "updated_at", "title"]),
    ("get", "/api/v1/runs"): ("-created_at", ["created_at"]),
    ("get", "/api/v1/runs/{run_id}/scenarios"): (
        "created_at",
        ["created_at", "status", "role", "interface_id"],
    ),
}

FILTERS = {
    ("get", "/api/v1/plans"): {"target_id", "saved"},
    ("get", "/api/v1/plans/{plan_id}/cells"): {"status", "feature_id"},
    ("get", "/api/v1/scenarios"): {
        "target_id",
        "status",
        "origin",
        "family",
        "feature_id",
        "cell_id",
        "plan_id",
        "q",
        "include_synthetic",
    },
    ("get", "/api/v1/runs"): {
        "target_id",
        "status",
        "kind",
        "plan_id",
        "created_after",
        "created_before",
    },
    ("get", "/api/v1/runs/{run_id}/scenarios"): {"status", "verdict", "family", "role"},
    ("get", "/api/v1/runs/{run_id}/browser-sessions"): {"status"},
    ("get", "/api/v1/feeds/runs"): {"target_id", "kind", "run_id"},
}

PAGINATION_PARAMETERS = {"limit", "cursor", "include_total", "sort"}
MEMBER_ONLY = {
    ("post", "/api/v1/plans"),
    ("patch", "/api/v1/plans/{plan_id}"),
    ("delete", "/api/v1/plans/{plan_id}"),
    ("post", "/api/v1/runs"),
    ("post", "/api/v1/runs/{run_id}/cancel"),
}


@pytest.fixture(scope="module")
def document() -> dict[str, Any]:
    return build_openapi_document()


def operation_of(document: dict[str, Any], method: str, path: str) -> dict[str, Any]:
    operation: dict[str, Any] = document["paths"][path][method]
    return operation


def parameters_of(operation: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {parameter["name"]: parameter for parameter in operation.get("parameters", [])}


def schema_name(reference: dict[str, Any]) -> str:
    return str(reference["$ref"]).rsplit("/", 1)[-1]


def test_every_operation_of_the_stage_two_api_surface_is_published(
    document: dict[str, Any],
) -> None:
    published = {(method, path) for path, item in document["paths"].items() for method in item}
    assert published >= STAGE_TWO_OPERATIONS
    assert ("get", "/api/v1/runs/{run_id}/events") in published


def test_every_stage_two_schema_keeps_its_contract_name(document: dict[str, Any]) -> None:
    assert set(document["components"]["schemas"]) >= STAGE_TWO_SCHEMAS


@pytest.mark.parametrize(("method", "path"), sorted(RESPONSE_MODELS))
def test_each_operation_answers_with_its_contract_model_and_status(
    document: dict[str, Any], method: str, path: str
) -> None:
    status, model = RESPONSE_MODELS[(method, path)]
    response = operation_of(document, method, path)["responses"][status]
    assert schema_name(response["content"]["application/json"]["schema"]) == model


@pytest.mark.parametrize(("method", "path"), sorted(REQUEST_MODELS))
def test_each_write_takes_its_contract_request_model(
    document: dict[str, Any], method: str, path: str
) -> None:
    body = operation_of(document, method, path)["requestBody"]["content"]["application/json"]
    assert schema_name(body["schema"]) == REQUEST_MODELS[(method, path)]


def test_delete_plan_answers_204_without_a_body(document: dict[str, Any]) -> None:
    responses = operation_of(document, "delete", "/api/v1/plans/{plan_id}")["responses"]
    assert "204" in responses
    assert "content" not in responses["204"]


def test_stage_two_operations_declare_bearer_auth_except_the_signed_artifact_route(
    document: dict[str, Any],
) -> None:
    for method, path in STAGE_TWO_OPERATIONS:
        operation = operation_of(document, method, path)
        if path == "/api/v1/artifacts/{token}":
            assert "security" not in operation
            assert "401" not in operation["responses"]
        elif (method, path) in BEARER_OR_SERVICE_KEY_OPERATIONS:
            assert operation["security"] == [{"bearerAuth": []}, {"serviceKey": []}]
            assert "401" in operation["responses"], (method, path)
        else:
            assert operation["security"] == [{"bearerAuth": []}], (method, path)
            assert "401" in operation["responses"], (method, path)


def test_member_writes_declare_403_and_the_reads_need_no_special_role_text(
    document: dict[str, Any],
) -> None:
    for method, path in MEMBER_ONLY:
        assert "403" in operation_of(document, method, path)["responses"]


def test_post_runs_requires_an_idempotency_key_and_post_plans_takes_one_optionally(
    document: dict[str, Any],
) -> None:
    runs = parameters_of(operation_of(document, "post", "/api/v1/runs"))
    assert runs["Idempotency-Key"]["required"] is True
    plans = parameters_of(operation_of(document, "post", "/api/v1/plans"))
    assert plans["Idempotency-Key"]["required"] is False
    preview = parameters_of(operation_of(document, "post", "/api/v1/plans/preview"))
    assert "Idempotency-Key" not in preview


@pytest.mark.parametrize(("method", "path"), sorted(PAGED_OPERATIONS))
def test_paged_operations_take_the_pagination_parameters_and_document_their_sort(
    document: dict[str, Any], method: str, path: str
) -> None:
    default, keys = PAGED_OPERATIONS[(method, path)]
    parameters = parameters_of(operation_of(document, method, path))
    assert set(parameters) >= PAGINATION_PARAMETERS
    assert parameters["limit"]["schema"]["default"] == 50
    assert parameters["limit"]["schema"]["maximum"] == 200
    description = parameters["sort"]["description"]
    assert f"Default: {default}." in description
    assert f"Allowed: {', '.join(keys)}." in description


@pytest.mark.parametrize(("method", "path"), sorted(FILTERS))
def test_list_operations_name_the_contract_filters(
    document: dict[str, Any], method: str, path: str
) -> None:
    parameters = set(parameters_of(operation_of(document, method, path)))
    query_names = {
        name
        for name, parameter in parameters_of(operation_of(document, method, path)).items()
        if parameter["in"] == "query"
    }
    assert FILTERS[(method, path)] <= parameters
    assert query_names - PAGINATION_PARAMETERS == FILTERS[(method, path)]


def test_multi_value_filters_repeat_and_synthetic_scenarios_are_hidden_by_default(
    document: dict[str, Any],
) -> None:
    runs = parameters_of(operation_of(document, "get", "/api/v1/runs"))
    assert runs["status"]["schema"]["anyOf"][0]["type"] == "array"
    assert runs["kind"]["schema"]["anyOf"][0]["type"] == "array"
    scenarios = parameters_of(operation_of(document, "get", "/api/v1/scenarios"))
    assert scenarios["include_synthetic"]["schema"]["default"] is False
    assert scenarios["q"]["schema"]["anyOf"][0]["maxLength"] == 200


def test_the_artifact_route_serves_binary_media_with_range_support(
    document: dict[str, Any],
) -> None:
    operation = operation_of(document, "get", "/api/v1/artifacts/{token}")
    for status in ("200", "206"):
        assert set(operation["responses"][status]["content"]) == {
            "image/png",
            "video/webm",
            "application/zip",
        }
    assert {"403", "404"} <= set(operation["responses"])


def test_the_runs_feed_is_a_server_sent_event_stream(document: dict[str, Any]) -> None:
    response = operation_of(document, "get", "/api/v1/feeds/runs")["responses"]["200"]
    assert list(response["content"]) == ["text/event-stream"]


def test_step_payloads_are_discriminated_unions_on_the_inner_kind(
    document: dict[str, Any],
) -> None:
    schemas = document["components"]["schemas"]
    kinds = ("http", "sse", "browser", "websocket", "graphql")
    for name, suffix in (("StepRequest", "StepRequest"), ("StepResponse", "StepResponse")):
        union = schemas[name]
        assert union["discriminator"]["propertyName"] == "kind"
        assert {
            schema_name({"$ref": ref}) for ref in union["discriminator"]["mapping"].values()
        } == {f"{kind.capitalize()}{suffix}" for kind in kinds}
        assert set(union["discriminator"]["mapping"]) == set(kinds)
    step = schemas["Step"]["properties"]
    assert schema_name(step["request"]["anyOf"][0]) == "StepRequest"
    assert schema_name(step["response"]["anyOf"][0]) == "StepResponse"


def required_and_nullable(schema: dict[str, Any], name: str) -> bool:
    prop = schema["properties"][name]
    nullable = any(option.get("type") == "null" for option in prop.get("anyOf", []))
    return name in schema["required"] and nullable


@pytest.mark.parametrize(
    ("model", "field"),
    [
        ("Run", "stop_requested_at"),
        ("Plan", "schedule_id"),
        ("CoverageCell", "reason"),
        ("CoverageCell", "skip_reason"),
        ("CoverageCell", "last_verdict"),
        ("Step", "verdict"),
        ("Step", "request"),
        ("Verdict", "skip_reason"),
        ("RunConfigSnapshot", "seed_hash"),
        ("RunConfigSnapshot", "clock"),
        ("RunConfigSnapshot", "models"),
        ("RunConfigSnapshot", "probe_bank_version"),
        ("PlanPreview", "estimated_cost_usd"),
    ],
)
def test_declared_later_stage_fields_are_always_present_and_nullable(
    document: dict[str, Any], model: str, field: str
) -> None:
    schema = document["components"]["schemas"][model]
    assert required_and_nullable(schema, field), (model, field)


def test_constants_declared_now_are_typed_as_the_plan_says(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    assert schemas["Plan"]["properties"]["is_coverage_baseline"]["type"] == "boolean"
    assert "is_coverage_baseline" in schemas["Plan"]["required"]
    assert schemas["Step"]["properties"]["payload_purged"]["type"] == "boolean"
    assert "payload_purged" in schemas["Step"]["required"]
    for name in ("Scenario", "ScenarioSummary"):
        assert "synthetic" in schemas[name]["required"]


def test_scenario_summary_drops_the_yaml_and_parsed_body(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    assert {"yaml", "parsed"} <= set(schemas["Scenario"]["properties"])
    assert not {"yaml", "parsed"} & set(schemas["ScenarioSummary"]["properties"])
    assert set(schemas["Scenario"]["properties"]) - set(
        schemas["ScenarioSummary"]["properties"]
    ) == {
        "yaml",
        "parsed",
    }


def test_run_is_the_summary_plus_the_detail_fields(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    summary = set(schemas["RunSummary"]["properties"])
    assert summary == {
        "id",
        "kind",
        "target_id",
        "plan_id",
        "status",
        "counters",
        "budget",
        "read_only",
        "started_at",
        "finished_at",
        "created_at",
    }
    assert set(schemas["Run"]["properties"]) - summary == {
        "trigger",
        "bundle_id",
        "config_snapshot",
        "event_head_seq",
        "workflow_id",
        "temporal_ui_url",
        "stop_requested_at",
        "created_by",
    }


def test_run_scenario_is_the_summary_plus_attempts_steps_yaml_and_skip_reason(
    document: dict[str, Any],
) -> None:
    schemas = document["components"]["schemas"]
    assert set(schemas["RunScenarioSummary"]["properties"]) == {
        "id",
        "scenario_id",
        "title",
        "family",
        "role",
        "interface_id",
        "status",
        "verdict",
        "attempts_total",
        "attempts_done",
        "duration_ms",
    }
    assert set(schemas["RunScenario"]["properties"]) - set(
        schemas["RunScenarioSummary"]["properties"]
    ) == {"attempts", "steps", "scenario_yaml", "skip_reason"}


def test_plan_selection_carries_the_contract_fields(document: dict[str, Any]) -> None:
    selection = document["components"]["schemas"]["PlanSelection"]
    assert set(selection["properties"]) == {
        "feature_ids",
        "area_ids",
        "roles",
        "interface_mode",
        "depth",
        "k",
        "budget",
    }
    assert set(selection["required"]) == {"interface_mode", "depth", "k"}
    assert selection["properties"]["k"]["minimum"] == 1
    assert selection["properties"]["k"]["maximum"] == 10


def test_plan_preview_lists_the_contract_fields(document: dict[str, Any]) -> None:
    preview = document["components"]["schemas"]["PlanPreview"]
    assert set(preview["properties"]) == {
        "cells_total",
        "scenarios_estimated",
        "skipped",
        "warnings",
        "effective_budget",
        "estimated_cost_usd",
    }
    assert set(preview["required"]) == set(preview["properties"])


def selection(**overrides: Any) -> dict[str, Any]:
    return {"interface_mode": "both", "depth": "smoke", "k": 1, **overrides}


def test_a_selection_rejects_unknown_depth_mode_and_attempt_counts() -> None:
    PlanSelection.model_validate(selection())
    for bad in ({"depth": "exhaustive"}, {"interface_mode": "some"}, {"k": 0}, {"k": 11}):
        with pytest.raises(ValidationError):
            PlanSelection.model_validate(selection(**bad))


def test_a_selection_budget_is_optional() -> None:
    assert PlanSelection.model_validate(selection()).budget is None
    parsed = PlanSelection.model_validate(selection(budget={"max_usd": 2, "max_minutes": 10}))
    assert parsed.budget is not None
    assert parsed.budget.max_minutes == 10


def test_a_run_names_exactly_one_plan() -> None:
    plan = {
        "target_id": "0198f6f2-7b00-7a00-9d00-000000000006",
        "saved": False,
        "selection": selection(),
    }
    plan_id = "0198f6f2-7b00-7a00-9d00-000000000003"
    RunCreate.model_validate({"plan_id": plan_id})
    RunCreate.model_validate({"plan": plan, "max_concurrency": 2})
    for bad in ({}, {"plan_id": plan_id, "plan": plan}, {"plan_id": plan_id, "max_concurrency": 0}):
        with pytest.raises(ValidationError):
            RunCreate.model_validate(bad)
