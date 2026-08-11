import json
import subprocess
import sys
from typing import Any

import pytest

from tessa_api.openapi_export import (
    API_ROOT,
    OPENAPI_PATH,
    build_openapi_document,
    render_openapi,
)
from tessa_api.settings import Settings
from tests.test_schema_publisher import STREAM_EVENT_TYPES

PUBLIC_OPERATIONS = {
    ("get", "/"),
    ("get", "/health"),
    ("get", "/schemas/index.json"),
    ("get", "/schemas/{name}.v{version}.json"),
}
SERVICE_KEY_OPERATIONS = {("post", "/api/v1/auth/credentials/verify")}
BEARER_OR_SERVICE_KEY_OPERATIONS = {
    ("get", "/api/v1/runs/{run_id}"),
    ("get", "/api/v1/targets/{target_id}/bundles"),
    ("post", "/api/v1/schedules/{schedule_id}/run-now"),
}
SIGNED_OPERATIONS = {("get", "/api/v1/artifacts/{token}")}


@pytest.fixture(scope="module")
def document() -> dict[str, Any]:
    return build_openapi_document()


def operations(document: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    return [
        (method, path, operation)
        for path, item in document["paths"].items()
        for method, operation in item.items()
    ]


def test_export_is_deterministic() -> None:
    assert render_openapi(build_openapi_document()) == render_openapi(build_openapi_document())


def test_export_does_not_depend_on_settings_values(settings: Settings) -> None:
    assert render_openapi(build_openapi_document(settings)) == render_openapi(
        build_openapi_document()
    )


def test_committed_file_matches_a_fresh_export() -> None:
    committed = OPENAPI_PATH.read_text(encoding="utf-8")
    assert committed == render_openapi(build_openapi_document())


def test_committed_file_uses_lf_line_endings() -> None:
    assert b"\r\n" not in OPENAPI_PATH.read_bytes()


def test_export_script_check_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/export_openapi.py", "--check"],
        cwd=API_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_every_protected_operation_declares_bearer_auth(document: dict[str, Any]) -> None:
    for method, path, operation in operations(document):
        key = (method, path)
        if key in PUBLIC_OPERATIONS or key in SIGNED_OPERATIONS:
            assert "security" not in operation, key
        elif key in SERVICE_KEY_OPERATIONS:
            assert operation["security"] == [{"serviceKey": []}], key
        elif key in BEARER_OR_SERVICE_KEY_OPERATIONS:
            assert operation["security"] == [{"bearerAuth": []}, {"serviceKey": []}], key
        else:
            assert operation["security"] == [{"bearerAuth": []}], key
    assert set(document["components"]["securitySchemes"]) == {"bearerAuth", "serviceKey"}


def test_internal_and_websocket_paths_are_not_published(document: dict[str, Any]) -> None:
    for path in document["paths"]:
        assert not path.startswith("/internal")
        assert not path.startswith("/ws")


def test_stream_types_are_in_components(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    assert "StreamEvent" in schemas
    assert "StreamClientMessage" in schemas
    assert schemas["StreamEvent"]["discriminator"]["propertyName"] == "type"
    assert set(schemas["StreamEvent"]["discriminator"]["mapping"]) == STREAM_EVENT_TYPES


def test_contract_model_names_are_exported_unchanged(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    for name in (
        "RootInfo",
        "HealthStatus",
        "DependencyHealth",
        "SchemaIndex",
        "CredentialsVerifyRequest",
        "AuthUser",
        "WsTicketCreate",
        "WsTicket",
        "HelloRunCreate",
        "RunHandle",
        "RunEventPage",
        "ErrorResponse",
    ):
        assert name in schemas, name


def test_ingest_models_stay_out_of_the_public_document(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    assert "IngestEventBatch" not in schemas
    assert "IngestEventResult" not in schemas


def test_default_fastapi_validation_schemas_are_replaced(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    assert "HTTPValidationError" not in schemas
    assert "ValidationError" not in schemas
    assert "HTTPValidationError" not in json.dumps(document)


def test_operation_ids_are_unique_and_tag_prefixed(document: dict[str, Any]) -> None:
    identifiers = [operation["operationId"] for _, _, operation in operations(document)]
    assert len(identifiers) == len(set(identifiers))
    for _, _, operation in operations(document):
        assert operation["operationId"].startswith(operation["tags"][0].replace("-", "_") + "_")


def test_hello_run_requires_idempotency_key_header(document: dict[str, Any]) -> None:
    operation = document["paths"]["/api/v1/system/hello-runs"]["post"]
    header = next(p for p in operation["parameters"] if p["name"] == "Idempotency-Key")
    assert header["in"] == "header"
    assert header["required"] is True
    assert "202" in operation["responses"]


def test_every_error_response_uses_the_error_envelope(document: dict[str, Any]) -> None:
    for _, _, operation in operations(document):
        for status, response in operation["responses"].items():
            if status.startswith(("4", "5")):
                schema = response["content"]["application/json"]["schema"]
                assert schema == {"$ref": "#/components/schemas/ErrorResponse"}


def test_timestamps_are_declared_as_date_time(document: dict[str, Any]) -> None:
    ticket = document["components"]["schemas"]["WsTicket"]["properties"]["expires_at"]
    assert ticket["format"] == "date-time"


def test_stream_payload_properties_have_descriptions(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]
    for name, schema in schemas.items():
        if name.endswith("Payload") or name in {"StreamLimits", "TileQuality"}:
            for property_name, property_schema in schema.get("properties", {}).items():
                assert "description" in property_schema, f"{name}.{property_name}"
