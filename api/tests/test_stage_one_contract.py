from typing import Any

import pytest

from tessa_api.openapi_export import build_openapi_document
from tests.test_openapi import BEARER_OR_SERVICE_KEY_OPERATIONS

STAGE_ONE_OPERATIONS = {
    ("get", "/api/v1/targets"),
    ("post", "/api/v1/targets"),
    ("get", "/api/v1/targets/{target_id}"),
    ("patch", "/api/v1/targets/{target_id}"),
    ("delete", "/api/v1/targets/{target_id}"),
    ("post", "/api/v1/targets/{target_id}/token/rotate"),
    ("get", "/api/v1/app-kinds"),
    ("get", "/api/v1/limits"),
    ("get", "/api/v1/prompt-templates"),
    ("get", "/api/v1/prompt-templates/{name}"),
    ("post", "/api/v1/targets/{target_id}/prompt-issues"),
    ("get", "/api/v1/targets/{target_id}/prompt-issues"),
    ("get", "/api/v1/prompt-issues/{prompt_issue_id}"),
    ("post", "/api/v1/bundles"),
    ("post", "/api/v1/bundles/paste"),
    ("get", "/api/v1/targets/{target_id}/bundles"),
    ("get", "/api/v1/bundles/{bundle_id}"),
    ("get", "/api/v1/bundles/{bundle_id}/diff"),
    ("get", "/api/v1/bundles/{bundle_id}/files"),
    ("get", "/api/v1/bundles/{bundle_id}/files/{path}"),
    ("get", "/api/v1/catalog"),
    ("get", "/api/v1/catalog/items/{catalog_item_id}"),
    ("get", "/api/v1/targets/{target_id}/environment"),
    ("patch", "/api/v1/targets/{target_id}/environment"),
    ("post", "/api/v1/targets/{target_id}/health-checks"),
    ("get", "/api/v1/targets/{target_id}/health"),
}

STAGE_ONE_SCHEMAS = {
    "AppKindList",
    "Bundle",
    "BundleCompleteness",
    "BundleCompletenessCheck",
    "BundleDiff",
    "BundleFileContent",
    "BundleFileList",
    "BundlePasteCreate",
    "BundleSummary",
    "BundleSummaryPage",
    "BundleUploadForm",
    "BundleUploadResult",
    "BundleValidationError",
    "Catalog",
    "CatalogItem",
    "DiscoveryPromptParams",
    "EnvironmentList",
    "EnvironmentPatch",
    "EnvironmentVariable",
    "FixupPromptParams",
    "HealthCheckCreate",
    "HealthReport",
    "HealthState",
    "LimitsRead",
    "PromptIssue",
    "PromptIssueCreate",
    "PromptIssuePage",
    "PromptTemplate",
    "PromptTemplatePage",
    "Target",
    "TargetCreate",
    "TargetPage",
    "TargetSummary",
    "TargetUpdate",
}

PAGED_OPERATIONS = {
    ("get", "/api/v1/targets"),
    ("get", "/api/v1/prompt-templates"),
    ("get", "/api/v1/targets/{target_id}/prompt-issues"),
    ("get", "/api/v1/targets/{target_id}/bundles"),
}


@pytest.fixture(scope="module")
def document() -> dict[str, Any]:
    return build_openapi_document()


def test_every_stage_one_operation_is_published(document: dict[str, Any]) -> None:
    published = {(method, path) for path, item in document["paths"].items() for method in item}
    assert published >= STAGE_ONE_OPERATIONS


def test_every_stage_one_schema_keeps_its_contract_name(document: dict[str, Any]) -> None:
    assert set(document["components"]["schemas"]) >= STAGE_ONE_SCHEMAS


def test_stage_one_operations_declare_bearer_auth_and_the_error_envelope(
    document: dict[str, Any],
) -> None:
    for method, path in STAGE_ONE_OPERATIONS:
        operation = document["paths"][path][method]
        expected: list[dict[str, list[str]]] = (
            [{"bearerAuth": []}, {"serviceKey": []}]
            if (method, path) in BEARER_OR_SERVICE_KEY_OPERATIONS
            else [{"bearerAuth": []}]
        )
        assert operation["security"] == expected, (method, path)
        assert "401" in operation["responses"], (method, path)


@pytest.mark.parametrize(("method", "path"), sorted(PAGED_OPERATIONS))
def test_paged_operations_take_the_pagination_parameters(
    document: dict[str, Any], method: str, path: str
) -> None:
    parameters = {p["name"]: p for p in document["paths"][path][method]["parameters"]}
    assert {"limit", "cursor", "include_total", "sort"} <= set(parameters)
    assert parameters["limit"]["schema"]["default"] == 50
    assert parameters["limit"]["schema"]["maximum"] == 200


def test_bundle_posts_require_an_idempotency_key(document: dict[str, Any]) -> None:
    for path in ("/api/v1/bundles", "/api/v1/bundles/paste"):
        operation = document["paths"][path]["post"]
        header = next(p for p in operation["parameters"] if p["name"] == "Idempotency-Key")
        assert header["required"] is True
        assert {"200", "201"} <= set(operation["responses"])


def test_the_prompt_issue_key_is_optional(document: dict[str, Any]) -> None:
    operation = document["paths"]["/api/v1/targets/{target_id}/prompt-issues"]["post"]
    header = next(p for p in operation["parameters"] if p["name"] == "Idempotency-Key")
    assert header["required"] is False
    assert "201" in operation["responses"]


def test_the_upload_body_is_multipart_and_the_paste_body_is_json(document: dict[str, Any]) -> None:
    upload = document["paths"]["/api/v1/bundles"]["post"]["requestBody"]["content"]
    paste = document["paths"]["/api/v1/bundles/paste"]["post"]["requestBody"]["content"]
    assert upload["multipart/form-data"]["schema"] == {
        "$ref": "#/components/schemas/BundleUploadForm"
    }
    assert paste["application/json"]["schema"] == {"$ref": "#/components/schemas/BundlePasteCreate"}
    form = document["components"]["schemas"]["BundleUploadForm"]
    assert form["required"] == ["file"]
    assert form["properties"]["note"]["anyOf"][0]["maxLength"] == 500


def test_prompt_issue_create_is_a_union_discriminated_on_the_template_name(
    document: dict[str, Any],
) -> None:
    union = document["components"]["schemas"]["PromptIssueCreate"]
    assert union["discriminator"]["propertyName"] == "template_name"
    assert union["discriminator"]["mapping"] == {
        "discovery": "#/components/schemas/DiscoveryPromptParams",
        "fixup": "#/components/schemas/FixupPromptParams",
        "explain": "#/components/schemas/ExplainPromptParams",
        "author": "#/components/schemas/AuthorPromptParams",
        "mutants": "#/components/schemas/MutantsPromptParams",
        "hooks": "#/components/schemas/HooksPromptParams",
        "propose": "#/components/schemas/ProposePromptParams",
    }


def test_bundle_carries_the_proportional_completeness_fields(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    assert {"id", "label", "passed", "weight", "earned", "detail", "fix_hint"} == set(
        schemas["BundleCompletenessCheck"]["properties"]
    )
    bundle = set(schemas["Bundle"]["properties"])
    assert {
        "hooks_missing",
        "scenarios_imported",
        "mutants_imported",
        "diff_summary",
        "completeness",
    } <= bundle
    result = schemas["BundleUploadResult"]
    assert set(result["required"]) == {"bundle", "created", "dry_run_run_id"}


def test_environment_value_is_optional_and_patch_has_set_and_clear(
    document: dict[str, Any],
) -> None:
    schemas = document["components"]["schemas"]
    assert "value" not in schemas["EnvironmentVariable"]["required"]
    assert set(schemas["EnvironmentPatch"]["properties"]) == {"set", "clear"}
    assert set(schemas["EnvironmentList"]["required"]) == {"items", "missing_required"}


def test_limits_has_the_three_contract_fields(document: dict[str, Any]) -> None:
    limits = document["components"]["schemas"]["LimitsRead"]
    assert set(limits["properties"]) == {
        "bundle_max_zip_bytes",
        "bundle_max_manifest_bytes",
        "explanation_max_chars",
    }
    assert set(limits["required"]) == set(limits["properties"])


def test_catalog_nullable_ids_are_always_present(document: dict[str, Any]) -> None:
    catalog = document["components"]["schemas"]["Catalog"]
    assert {"bundle_id", "bundle_version", "roles", "interfaces", "areas"} <= set(
        catalog["required"]
    )


def test_catalog_query_names_the_documented_filters(document: dict[str, Any]) -> None:
    parameters = {p["name"]: p for p in document["paths"]["/api/v1/catalog"]["get"]["parameters"]}
    assert set(parameters) == {
        "target_id",
        "bundle_id",
        "area",
        "kind",
        "role",
        "interface_id",
        "confidence",
        "q",
    }
    assert parameters["target_id"]["required"] is True
