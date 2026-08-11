import json
from typing import Any

import pytest

from tessa_api.openapi_export import OPENAPI_PATH, build_openapi_document

STAGE_THREE_OPERATIONS = {
    ("get", "/api/v1/targets/{target_id}/seeds"),
    ("get", "/api/v1/seeds/{seed_id}"),
    ("post", "/api/v1/targets/{target_id}/seeds/verify"),
    ("post", "/api/v1/targets/{target_id}/seeds/reset"),
    ("get", "/api/v1/oracle-templates"),
    ("get", "/api/v1/oracle-templates/{oracle_template_id}"),
    ("post", "/api/v1/oracle-templates/{oracle_template_id}/runs"),
    ("get", "/api/v1/oracle-results/{oracle_result_id}"),
    ("get", "/api/v1/oracle-templates/{oracle_template_id}/results"),
    ("put", "/api/v1/oracle-templates/{oracle_template_id}/approval"),
}
STAGE_FOUR_OPERATIONS = {
    ("get", "/api/v1/probes"),
    ("get", "/api/v1/settings"),
    ("patch", "/api/v1/settings"),
    ("put", "/api/v1/settings/secrets/{name}"),
    ("delete", "/api/v1/settings/secrets/{name}"),
    ("post", "/api/v1/settings/test/{service}"),
    ("get", "/api/v1/labels/queue"),
    ("get", "/api/v1/labels"),
    ("get", "/api/v1/labels/stats"),
    ("post", "/api/v1/labels"),
    ("delete", "/api/v1/labels/{label_id}"),
}
OPERATIONS = STAGE_THREE_OPERATIONS | STAGE_FOUR_OPERATIONS

SCHEMAS = {
    "Seed",
    "SeedPage",
    "SeedVerifyCreate",
    "SeedResetCreate",
    "OracleTemplate",
    "OracleTemplatePage",
    "OracleRunCreate",
    "OracleResult",
    "OracleResultPage",
    "OracleApprovalSet",
    "GoldPoint",
    "DbCheck",
    "Probe",
    "ProbePage",
    "ProbeResult",
    "JudgeResult",
    "EvidenceBlock",
    "Label",
    "LabelCreate",
    "LabelPage",
    "LabelTask",
    "LabelTaskPage",
    "LabelStats",
    "SettingsRead",
    "SettingsPatch",
    "SecretSet",
    "SecretStatus",
    "ServiceTestResult",
    "SeedProgressEvent",
    "StepGradedEvent",
}

RESPONSE_MODELS = {
    ("get", "/api/v1/targets/{target_id}/seeds"): ("200", "SeedPage"),
    ("get", "/api/v1/seeds/{seed_id}"): ("200", "Seed"),
    ("post", "/api/v1/targets/{target_id}/seeds/verify"): ("202", "RunHandle"),
    ("post", "/api/v1/targets/{target_id}/seeds/reset"): ("202", "RunHandle"),
    ("get", "/api/v1/oracle-templates"): ("200", "OracleTemplatePage"),
    ("get", "/api/v1/oracle-templates/{oracle_template_id}"): ("200", "OracleTemplate"),
    ("post", "/api/v1/oracle-templates/{oracle_template_id}/runs"): ("202", "OracleResult"),
    ("get", "/api/v1/oracle-results/{oracle_result_id}"): ("200", "OracleResult"),
    ("get", "/api/v1/oracle-templates/{oracle_template_id}/results"): ("200", "OracleResultPage"),
    ("put", "/api/v1/oracle-templates/{oracle_template_id}/approval"): ("200", "OracleTemplate"),
    ("get", "/api/v1/probes"): ("200", "ProbePage"),
    ("get", "/api/v1/settings"): ("200", "SettingsRead"),
    ("patch", "/api/v1/settings"): ("200", "SettingsRead"),
    ("put", "/api/v1/settings/secrets/{name}"): ("200", "SecretStatus"),
    ("post", "/api/v1/settings/test/{service}"): ("200", "ServiceTestResult"),
    ("get", "/api/v1/labels/queue"): ("200", "LabelTaskPage"),
    ("get", "/api/v1/labels"): ("200", "LabelPage"),
    ("get", "/api/v1/labels/stats"): ("200", "LabelStats"),
    ("post", "/api/v1/labels"): ("201", "Label"),
}

REQUEST_MODELS = {
    ("post", "/api/v1/targets/{target_id}/seeds/verify"): "SeedVerifyCreate",
    ("post", "/api/v1/targets/{target_id}/seeds/reset"): "SeedResetCreate",
    ("post", "/api/v1/oracle-templates/{oracle_template_id}/runs"): "OracleRunCreate",
    ("put", "/api/v1/oracle-templates/{oracle_template_id}/approval"): "OracleApprovalSet",
    ("patch", "/api/v1/settings"): "SettingsPatch",
    ("put", "/api/v1/settings/secrets/{name}"): "SecretSet",
    ("post", "/api/v1/labels"): "LabelCreate",
}

PAGED_OPERATIONS = {
    ("get", "/api/v1/targets/{target_id}/seeds"): ("-version", ["version"]),
    ("get", "/api/v1/oracle-templates"): ("name", ["name", "approval"]),
    ("get", "/api/v1/oracle-templates/{oracle_template_id}/results"): (
        "-created_at",
        ["created_at"],
    ),
    ("get", "/api/v1/probes"): ("pack,id", ["pack", "id"]),
    ("get", "/api/v1/labels/queue"): ("-created_at", ["created_at"]),
    ("get", "/api/v1/labels"): ("-labeled_at", ["labeled_at"]),
}

FILTERS = {
    ("get", "/api/v1/oracle-templates"): {"target_id", "bundle_id", "feature_id", "approval"},
    ("get", "/api/v1/probes"): {"pack", "q", "target_id"},
    ("get", "/api/v1/labels/queue"): {"subject_type", "reason", "target_id"},
    ("get", "/api/v1/labels"): {"subject_type", "subject_id", "source", "labeled_by"},
}

IDEMPOTENCY_REQUIRED = {
    ("post", "/api/v1/targets/{target_id}/seeds/verify"),
    ("post", "/api/v1/targets/{target_id}/seeds/reset"),
    ("post", "/api/v1/oracle-templates/{oracle_template_id}/runs"),
}
IDEMPOTENCY_OPTIONAL = {("post", "/api/v1/labels")}

MEMBER_WRITES = (
    IDEMPOTENCY_REQUIRED
    | IDEMPOTENCY_OPTIONAL
    | {
        ("put", "/api/v1/oracle-templates/{oracle_template_id}/approval"),
        ("delete", "/api/v1/labels/{label_id}"),
    }
)
ADMIN_WRITES = {
    ("patch", "/api/v1/settings"),
    ("put", "/api/v1/settings/secrets/{name}"),
    ("delete", "/api/v1/settings/secrets/{name}"),
    ("post", "/api/v1/settings/test/{service}"),
}
PAGINATION_PARAMETERS = {"limit", "cursor", "include_total", "sort"}
NO_CONTENT = {
    ("delete", "/api/v1/settings/secrets/{name}"),
    ("delete", "/api/v1/labels/{label_id}"),
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


def test_every_operation_of_the_stage_three_and_four_api_surface_is_published(
    document: dict[str, Any],
) -> None:
    published = {(method, path) for path, item in document["paths"].items() for method in item}
    assert published >= OPERATIONS
    assert len(OPERATIONS) == 21


def test_the_committed_openapi_file_publishes_every_stage_three_and_four_operation() -> None:
    committed = json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))
    published = {(method, path) for path, item in committed["paths"].items() for method in item}
    assert published >= OPERATIONS
    assert set(committed["components"]["schemas"]) >= SCHEMAS


def test_the_stage_three_and_four_operations_are_tagged_by_resource(
    document: dict[str, Any],
) -> None:
    prefixes = {
        "/api/v1/targets/{target_id}/seeds": "seeds",
        "/api/v1/seeds": "seeds",
        "/api/v1/oracle": "oracles",
        "/api/v1/probes": "probes",
        "/api/v1/settings": "settings",
        "/api/v1/labels": "labels",
    }
    for method, path in OPERATIONS:
        tag = next(tag for prefix, tag in prefixes.items() if path.startswith(prefix))
        assert operation_of(document, method, path)["tags"] == [tag], (method, path)


def test_every_stage_three_and_four_schema_keeps_its_contract_name(
    document: dict[str, Any],
) -> None:
    assert set(document["components"]["schemas"]) >= SCHEMAS


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


@pytest.mark.parametrize(("method", "path"), sorted(NO_CONTENT))
def test_deletes_answer_204_without_a_body(
    document: dict[str, Any], method: str, path: str
) -> None:
    responses = operation_of(document, method, path)["responses"]
    assert "204" in responses
    assert "content" not in responses["204"]


def test_posting_a_label_documents_both_the_created_and_the_replaced_answers(
    document: dict[str, Any],
) -> None:
    responses = operation_of(document, "post", "/api/v1/labels")["responses"]
    for status in ("200", "201"):
        assert schema_name(responses[status]["content"]["application/json"]["schema"]) == "Label"


def test_every_operation_declares_bearer_auth_and_the_roles_it_refuses(
    document: dict[str, Any],
) -> None:
    for method, path in OPERATIONS:
        operation = operation_of(document, method, path)
        assert operation["security"] == [{"bearerAuth": []}], (method, path)
        assert {"401", "403"} <= set(operation["responses"]), (method, path)
        assert "501" not in operation["responses"], (method, path)


@pytest.mark.parametrize(("method", "path"), sorted(IDEMPOTENCY_REQUIRED))
def test_workflow_starting_posts_require_an_idempotency_key(
    document: dict[str, Any], method: str, path: str
) -> None:
    key = parameters_of(operation_of(document, method, path))["Idempotency-Key"]
    assert key["required"] is True
    assert "400" in operation_of(document, method, path)["responses"]


@pytest.mark.parametrize(("method", "path"), sorted(IDEMPOTENCY_OPTIONAL))
def test_label_posts_take_an_optional_idempotency_key(
    document: dict[str, Any], method: str, path: str
) -> None:
    assert (
        parameters_of(operation_of(document, method, path))["Idempotency-Key"]["required"] is False
    )


def test_other_operations_take_no_idempotency_key(document: dict[str, Any]) -> None:
    for method, path in OPERATIONS - IDEMPOTENCY_REQUIRED - IDEMPOTENCY_OPTIONAL:
        assert "Idempotency-Key" not in parameters_of(operation_of(document, method, path))


def test_seed_resets_document_the_refusals_the_contract_lists(document: dict[str, Any]) -> None:
    for path in (
        "/api/v1/targets/{target_id}/seeds/verify",
        "/api/v1/targets/{target_id}/seeds/reset",
    ):
        assert {"409", "422", "503"} <= set(operation_of(document, "post", path)["responses"])


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
def test_list_operations_name_the_contract_filters_and_nothing_else(
    document: dict[str, Any], method: str, path: str
) -> None:
    parameters = parameters_of(operation_of(document, method, path))
    query_names = {name for name, parameter in parameters.items() if parameter["in"] == "query"}
    assert query_names - PAGINATION_PARAMETERS == FILTERS[(method, path)]


def test_enum_filters_repeat_and_text_search_is_bounded(document: dict[str, Any]) -> None:
    probes = parameters_of(operation_of(document, "get", "/api/v1/probes"))
    assert probes["pack"]["schema"]["anyOf"][0]["type"] == "array"
    assert probes["q"]["schema"]["anyOf"][0]["maxLength"] == 200
    queue = parameters_of(operation_of(document, "get", "/api/v1/labels/queue"))
    assert queue["reason"]["schema"]["anyOf"][0]["type"] == "array"
    templates = parameters_of(operation_of(document, "get", "/api/v1/oracle-templates"))
    assert templates["approval"]["schema"]["anyOf"][0]["type"] == "array"


def test_secret_routes_accept_only_the_three_contract_names(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    assert schemas["SecretName"]["enum"] == [
        "openai_api_key",
        "anthropic_api_key",
        "slack_webhook_url",
    ]
    assert schemas["ServiceName"]["enum"] == [
        "laya",
        "openai",
        "anthropic",
        "temporal",
        "slack",
    ]
    secret_path = parameters_of(operation_of(document, "put", "/api/v1/settings/secrets/{name}"))
    assert schema_name(secret_path["name"]["schema"]) == "SecretName"


def test_the_secret_value_is_declared_write_only(document: dict[str, Any]) -> None:
    value = document["components"]["schemas"]["SecretSet"]["properties"]["value"]
    assert value["writeOnly"] is True
    assert value["format"] == "password"


def test_secret_status_exposes_no_value_field(document: dict[str, Any]) -> None:
    assert set(document["components"]["schemas"]["SecretStatus"]["properties"]) == {
        "name",
        "has_value",
        "last_set_at",
        "last_set_by",
        "source",
    }


def test_settings_patch_forbids_unknown_keys_and_lists_the_contract_groups(
    document: dict[str, Any],
) -> None:
    schemas = document["components"]["schemas"]
    patch = schemas["SettingsPatch"]
    assert patch["additionalProperties"] is False
    assert set(patch["properties"]) == {
        "models",
        "thresholds",
        "endpoints",
        "budgets",
        "notifications",
        "policies",
    }
    assert not patch.get("required")
    assert set(schemas["SettingsRead"]["properties"]) - set(patch["properties"]) == {
        "overrides",
        "secrets",
    }
    for name in (
        "ModelSettingsPatch",
        "ThresholdSettingsPatch",
        "EndpointSettingsPatch",
        "BudgetSettingsPatch",
    ):
        assert schemas[name]["additionalProperties"] is False
        assert not schemas[name].get("required")
        assert "source" not in schemas[name]["properties"]


def test_settings_read_carries_the_contract_groups_and_the_overrides_list(
    document: dict[str, Any],
) -> None:
    settings = document["components"]["schemas"]["SettingsRead"]
    assert set(settings["properties"]) == {
        "models",
        "thresholds",
        "endpoints",
        "budgets",
        "notifications",
        "policies",
        "overrides",
        "secrets",
    }
    assert set(settings["required"]) == set(settings["properties"])
    assert settings["properties"]["overrides"]["items"] == {"type": "string"}
    model = document["components"]["schemas"]["ModelSettings"]
    assert set(model["properties"]) == {"model", "effort", "max_usd", "timeout_seconds", "source"}


def test_the_effort_and_role_enums_match_the_contract(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    assert schemas["Effort"]["enum"] == ["minimal", "low", "medium", "high"]
    assert schemas["ModelRole"]["enum"] == [
        "judge",
        "judge_tiebreak",
    ]


def required_and_nullable(schema: dict[str, Any], name: str) -> bool:
    prop = schema["properties"][name]
    nullable = any(option.get("type") == "null" for option in prop.get("anyOf", []))
    return name in schema["required"] and nullable


@pytest.mark.parametrize(
    ("model", "field"),
    [
        ("Seed", "declared_hash"),
        ("Seed", "observed_hash"),
        ("Seed", "last_reset_at"),
        ("Seed", "last_reset_status"),
        ("Seed", "last_reset_run_id"),
        ("Seed", "reset_script_path"),
        ("Seed", "hash_command"),
        ("OracleResult", "sentence"),
        ("OracleResult", "error"),
        ("OracleResult", "duration_ms"),
        ("OracleResult", "executed_at"),
        ("DbCheck", "oracle_result_id"),
        ("ProbeResult", "answer"),
        ("JudgeResult", "pairwise"),
        ("Label", "labeled_by"),
        ("Label", "note"),
        ("LabelTask", "machine_value"),
        ("LabelTask", "machine_confidence"),
        ("LabelStats", "agreement_with_machine"),
        ("SecretStatus", "last_set_at"),
        ("SecretStatus", "source"),
        ("ServiceTestResult", "latency_ms"),
        ("ServiceTestResult", "message"),
        ("SettingsRead", "notifications"),
        ("SettingsRead", "policies"),
        ("Step", "judge"),
        ("Step", "evidence"),
    ],
)
def test_nullable_fields_are_always_present_and_nullable(
    document: dict[str, Any], model: str, field: str
) -> None:
    assert required_and_nullable(document["components"]["schemas"][model], field), (model, field)


@pytest.mark.parametrize("field", ["gold_points", "db_checks", "probes"])
def test_the_declared_step_lists_are_required_arrays(document: dict[str, Any], field: str) -> None:
    step = document["components"]["schemas"]["Step"]
    assert field in step["required"]
    assert step["properties"][field]["type"] == "array"


def test_step_gains_exactly_the_stage_three_and_four_fields(document: dict[str, Any]) -> None:
    step = document["components"]["schemas"]["Step"]["properties"]
    assert {"gold_points", "db_checks", "probes", "judge", "evidence"} <= set(step)
    assert step["gold_points"]["items"]["$ref"].endswith("/GoldPoint")
    assert step["db_checks"]["items"]["$ref"].endswith("/DbCheck")
    assert step["probes"]["items"]["$ref"].endswith("/ProbeResult")
    assert schema_name(step["judge"]["anyOf"][0]) == "JudgeResult"
    assert schema_name(step["evidence"]["anyOf"][0]) == "EvidenceBlock"


def test_run_create_declares_reset_seed(document: dict[str, Any]) -> None:
    run_create = document["components"]["schemas"]["RunCreate"]
    assert run_create["properties"]["reset_seed"]["type"] == "boolean"
    assert run_create["properties"]["reset_seed"]["default"] is False
    assert "reset_seed" not in run_create.get("required", [])


def test_the_stream_union_names_the_new_events_with_typed_payloads(
    document: dict[str, Any],
) -> None:
    schemas = document["components"]["schemas"]
    mapping = schemas["StreamEvent"]["discriminator"]["mapping"]
    assert schema_name({"$ref": mapping["seed.progress"]}) == "SeedProgressEvent"
    assert schema_name({"$ref": mapping["step.graded"]}) == "StepGradedEvent"
    assert set(schemas["SeedProgressPayload"]["properties"]) == {
        "phase",
        "status",
        "observed_hash",
        "expected_hash",
    }
    assert set(schemas["StepGradedPayload"]["properties"]) == {
        "step_id",
        "run_scenario_id",
        "verdict",
        "escalated_to",
    }
    assert schemas["SeedPhase"]["enum"] == ["reset", "hash", "assert"]
    assert schemas["SeedPhaseStatus"]["enum"] == ["started", "ok", "failed"]


def test_the_judge_result_evidence_lists_gold_points_claims_and_forbidden_claims(
    document: dict[str, Any],
) -> None:
    schemas = document["components"]["schemas"]
    assert set(schemas["JudgeEvidence"]["properties"]) == {
        "gold_points",
        "must_not_claim",
        "unsupported_claims",
    }
    assert set(schemas["JudgeResult"]["properties"]) == {
        "id",
        "family",
        "model",
        "effort",
        "rubric_version",
        "verdict",
        "pairwise",
        "evidence",
        "cost_usd",
    }
    assert set(schemas["ProbeResult"]["properties"]) == {
        "id",
        "probe_id",
        "pack",
        "question",
        "answer",
        "status",
        "confidence",
        "threshold",
        "latency_ms",
        "probe_bank_version",
        "engine",
    }


def test_the_evidence_block_lists_exactly_the_allow_listed_fields(document: dict[str, Any]) -> None:
    evidence = document["components"]["schemas"]["EvidenceBlock"]
    assert set(evidence["properties"]) == {
        "ask",
        "answer",
        "gold_points",
        "must_not_claim",
        "unsupported_claim_candidates",
        "invariants",
        "rubric",
    }
    assert evidence["additionalProperties"] is False


def test_seed_and_oracle_models_carry_the_contract_fields(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    assert set(schemas["Seed"]["properties"]) == {
        "id",
        "target_id",
        "bundle_id",
        "version",
        "declared_hash",
        "hash_source",
        "observed_hash",
        "last_reset_at",
        "last_reset_status",
        "last_reset_run_id",
        "has_reset_script",
        "has_hash_command",
        "reset_script_path",
        "hash_command",
        "material_sha256",
    }
    assert set(schemas["OracleTemplate"]["properties"]) == {
        "id",
        "bundle_id",
        "name",
        "feature_ids",
        "language",
        "source",
        "params_schema",
        "sentence_template",
        "read_only_verified",
        "approval",
    }
    assert set(schemas["OracleResult"]["properties"]) == {
        "id",
        "oracle_template_id",
        "params",
        "status",
        "rows",
        "rows_truncated",
        "sentence",
        "error",
        "duration_ms",
        "executed_at",
    }
    assert set(schemas["DbCheck"]["properties"]) == {
        "name",
        "expected",
        "actual",
        "status",
        "oracle_result_id",
    }
    assert set(schemas["GoldPoint"]["properties"]) == {
        "key",
        "value",
        "oracle_result_id",
        "rendered",
    }


def test_label_models_carry_the_contract_fields(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    assert set(schemas["Label"]["properties"]) == {
        "id",
        "subject_type",
        "subject_id",
        "value",
        "source",
        "note",
        "labeled_by",
        "labeled_at",
    }
    assert set(schemas["LabelTask"]["properties"]) == {
        "id",
        "subject_type",
        "subject_id",
        "step_id",
        "run_id",
        "question",
        "machine_value",
        "machine_confidence",
        "evidence_excerpt",
        "reason",
        "created_at",
    }
    assert set(schemas["LabelStats"]["properties"]) == {
        "total_human",
        "total_weak",
        "by_subject_type",
        "agreement_with_machine",
    }
    assert schemas["LabelReason"]["enum"] == ["uncertain", "judge_flagged", "disagreement", "audit"]
    assert schemas["LabelCreate"]["properties"]["note"]["anyOf"][0]["maxLength"] == 1000


def test_activity_and_workflow_models_stay_out_of_the_public_document(
    document: dict[str, Any],
) -> None:
    schemas = document["components"]["schemas"]
    for internal in (
        "SeedTargetInput",
        "GradeStepInput",
        "JudgeStepInput",
        "JudgeStepOutput",
        "ModelCallSpec",
        "ProbeBatchResult",
        "ProbeBankFile",
    ):
        assert internal not in schemas
