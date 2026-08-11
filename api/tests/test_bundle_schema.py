import copy
import json
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import AdapterKind, AppKind, Confidence, FeatureKind
from tessa_api.services.schema_registry import SCHEMAS, build_schema_document
from tests.support import API_ROOT

BUNDLE_SCHEMA_PATH = API_ROOT.parent / "schemas" / "bundle.v1.json"
MUTANT_SCHEMA_PATH = API_ROOT.parent / "schemas" / "mutant.v1.json"
MUTANT_FORM_DEFINITION = "MutantFields"
UI_WIDGETS = {"text", "textarea", "select", "chips", "yaml", "sql", "number", "toggle"}
UI_KEYS = {"label", "group", "order", "widget"}
PLAN_SECTIONS = {
    "app",
    "interfaces",
    "roles",
    "features",
    "data_model",
    "truth_sources",
    "seeds",
    "invariants",
    "flags",
    "environment",
    "test_hooks",
    "limitations",
    "cleanup",
}
TARGET_TOKEN = "tgt_abcdefghijklmnopqrstuv"


def minimal_manifest() -> dict[str, Any]:
    return {
        "schema": "http://localhost:8000/schemas/bundle.v1.json",
        "target_token": TARGET_TOKEN,
        "app": {
            "name": "Gracie",
            "summary": "Hotel assistant",
            "kind": "llm_assistant",
            "how_to_run": "npm run dev",
        },
        "interfaces": [{"id": "chat_sse", "kind": "sse", "base_path": "/api/chat"}],
        "roles": [{"id": "admin", "level": 2, "description": "Property manager"}],
        "features": [
            {
                "id": "smart_log.read.open_maintenance",
                "area": "Smart Log",
                "kind": "read",
                "description": "List maintenance issues that are still open",
            }
        ],
        "environment": [{"name": "GRACIE_BASE_URL", "kind": "url", "secret": False}],
    }


def full_manifest() -> dict[str, Any]:
    manifest = minimal_manifest()
    manifest["app"].update(
        {"health_endpoints": ["GET /health"], "ports": [8080], "base_paths": ["/api"]}
    )
    manifest["interfaces"] = [
        {
            "id": "chat_sse",
            "kind": "sse",
            "base_path": "/api/chat",
            "auth": {
                "type": "bearer",
                "header": "Authorization",
                "token_source": {"admin": "POST /auth/login with ${ADMIN_EMAIL}"},
            },
            "health_endpoint": "/health",
            "shapes": [
                {
                    "name": "send chat message",
                    "method": "POST",
                    "path": "/chat",
                    "request_example": {"message": "Which rooms are dirty?"},
                    "response_example": {"answer": "Three rooms."},
                }
            ],
            "stream_events": ["token", "done"],
            "rate_limits": "60 per minute",
            "idempotency": "Idempotency-Key on POST",
        },
        {"id": "browser", "kind": "browser", "base_path": "/"},
    ]
    manifest["roles"] = [
        {
            "id": "admin",
            "level": 2,
            "description": "Property manager",
            "can_see": ["all rooms"],
            "can_do": ["create issues"],
            "credential_env": "ADMIN_TOKEN",
        }
    ]
    manifest["features"] = [
        {
            "id": "smart_log.read.open_maintenance",
            "area": "Smart Log",
            "kind": "read",
            "description": "List maintenance issues that are still open",
            "interfaces": ["chat_sse", "browser"],
            "roles": ["all"],
            "flag": "none",
            "preconditions": ["seed.smart_log_history"],
            "examples": [
                {
                    "ask": "Which maintenance issues are still open?",
                    "expected": "count of open items, from the oracle",
                    "oracle": "open_maintenance",
                }
            ],
            "invariants": ["no_internal_ids"],
            "cleanup": "none",
            "confidence": "high",
        },
        {
            "id": "smart_log.write.create_issue",
            "area": "Smart Log",
            "kind": "write",
            "description": "Create a maintenance issue",
            "writes_to": "maintenance_issue",
            "confirmation": "button-only, typed yes accepted",
            "expect_db": {"table": "maintenance_issue", "where": {"status": "open"}},
            "cleanup": "delete the created issue",
        },
    ]
    manifest["data_model"] = {
        "stores": [
            {
                "name": "primary",
                "kind": "postgres",
                "entities": [
                    {
                        "name": "maintenance_issue",
                        "key_fields": ["id"],
                        "tenant_field": "property_id",
                        "status_fields": ["status"],
                        "soft_delete": "deleted_at is not null",
                    }
                ],
            }
        ],
        "timezone": "UTC in storage",
    }
    manifest["truth_sources"] = [
        {
            "id": "primary_db",
            "kind": "database",
            "description": "read replica",
            "connection_env": "TRUTH_DB_DSN",
            "dialect": "postgres",
        }
    ]
    manifest["seeds"] = {
        "description": "fixtures",
        "fixtures": ["seeds/fixtures.sql"],
        "reset_script": "seeds/reset.sql",
        "hash_command": "psql -At -f seeds/hash.sql",
        "expected_hash": "9f2c1d8e7b6a5d4c",
        "dsn_env": "SEED_DB_DSN",
    }
    manifest["invariants"] = [
        {"id": "no_internal_ids", "rule": "No internal ids in responses", "check": "code"}
    ]
    manifest["flags"] = [
        {
            "id": "new_checkout",
            "env_var": "FEATURE_NEW_CHECKOUT",
            "description": "single page checkout",
            "affects": ["shop.write.checkout"],
        }
    ]
    manifest["environment"] = [
        {
            "name": "GRACIE_BASE_URL",
            "kind": "url",
            "secret": False,
            "required": True,
            "purpose": "QA base URL",
            "interfaces": ["chat_sse"],
        },
        {"name": "ADMIN_TOKEN", "kind": "token"},
        {"name": "ADMIN_EMAIL", "kind": "string", "secret": False},
        {"name": "TRUTH_DB_DSN", "kind": "dsn"},
        {"name": "SEED_DB_DSN", "kind": "dsn"},
    ]
    manifest["test_hooks"] = {
        "available": [{"id": "health", "description": "Health probe", "endpoint": "GET /health"}],
        "missing": [{"id": "pin_clock", "description": "Pin the server clock"}],
    }
    manifest["limitations"] = ["no sandbox for payments"]
    manifest["cleanup"] = {
        "irreversible": ["sent emails"],
        "delete_after_run": ["created issues"],
        "costs_money": ["SMS"],
    }
    return manifest


def published_schema() -> dict[str, Any]:
    document: dict[str, Any] = json.loads(BUNDLE_SCHEMA_PATH.read_text(encoding="utf-8"))
    return document


def validator() -> Draft202012Validator:
    return Draft202012Validator(published_schema())


def mutate(base: dict[str, Any], path: list[str | int], value: Any) -> dict[str, Any]:
    manifest = copy.deepcopy(base)
    node: Any = manifest
    for step in path[:-1]:
        node = node[step]
    if value is DELETE:
        del node[path[-1]]
    else:
        node[path[-1]] = value
    return manifest


DELETE = object()


def test_the_minimal_manifest_is_valid_in_pydantic_and_in_the_published_schema() -> None:
    manifest = minimal_manifest()
    BundleManifest.model_validate(manifest)
    validator().validate(manifest)


def test_the_full_manifest_is_valid_in_pydantic_and_in_the_published_schema() -> None:
    manifest = full_manifest()
    parsed = BundleManifest.model_validate(manifest)
    validator().validate(manifest)
    assert parsed.schema_url == manifest["schema"]
    assert parsed.features[0].kind is FeatureKind.read
    assert parsed.features[0].confidence is Confidence.high
    assert parsed.features[1].confidence is Confidence.medium
    assert parsed.app.kind is AppKind.llm_assistant
    assert parsed.interfaces[0].kind is AdapterKind.sse


def test_dumping_by_alias_round_trips_through_the_published_schema() -> None:
    parsed = BundleManifest.model_validate(full_manifest())
    dumped = parsed.model_dump(mode="json", by_alias=True)
    assert "schema" in dumped
    assert "schema_url" not in dumped
    assert BundleManifest.model_validate(dumped) == parsed


def test_the_python_field_name_is_accepted_too() -> None:
    manifest = minimal_manifest()
    manifest["schema_url"] = manifest.pop("schema")
    assert BundleManifest.model_validate(manifest).schema_url.endswith("bundle.v1.json")


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (["unknown_section"], {"a": 1}),
        (["schema"], DELETE),
        (["target_token"], DELETE),
        (["target_token"], "tgt_SHORT"),
        (["target_token"], "abc_abcdefghijklmnopqrstuv"),
        (["app"], DELETE),
        (["interfaces"], DELETE),
        (["roles"], DELETE),
        (["features"], DELETE),
        (["environment"], DELETE),
        (["app", "kind"], "spaceship"),
        (["app", "name"], ""),
        (["app", "ports"], "8080"),
        (["interfaces", 0, "kind"], "carrier_pigeon"),
        (["interfaces", 0, "id"], "has space"),
        (["interfaces", 0, "base_path"], DELETE),
        (["roles", 0, "level"], -1),
        (["roles", 0, "credential_env"], "lower_case"),
        (["features", 0, "kind"], "teleport"),
        (["features", 0, "id"], DELETE),
        (["features", 0, "confidence"], "certain"),
        (["features", 0, "interfaces"], "chat_sse"),
        (["environment", 0, "name"], "lowercase"),
        (["environment", 0, "kind"], "blob"),
        (["environment", 0, "secret"], "yes please"),
        (["schema"], "http://localhost:8000/schemas/other.json"),
        (["schema"], "localhost:8000/schemas/bundle.v1.json"),
        (["schema"], ""),
        (["app", "ports"], [0]),
        (["app", "ports"], [70000]),
        (["interfaces"], []),
        (["roles"], []),
        (["features"], []),
        (["environment"], []),
    ],
)
def test_invalid_manifests_are_rejected_by_pydantic_and_the_published_schema_alike(
    path: list[str | int], value: Any
) -> None:
    manifest = mutate(minimal_manifest(), path, value)
    assert not validator().is_valid(manifest)
    with pytest.raises(ValidationError):
        BundleManifest.model_validate(manifest)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (["features", 0, "id"], DELETE),
        (["features", 0, "examples", 0, "expected"], DELETE),
        (["interfaces", 0, "auth", "type"], DELETE),
        (["truth_sources", 0, "kind"], "ftp"),
        (["truth_sources", 0, "connection_env"], "lower"),
        (["invariants", 0, "check"], "vibes"),
        (["seeds", "dsn_env"], "lower"),
        (["test_hooks", "missing", 0, "id"], DELETE),
        (["data_model", "stores", 0, "name"], DELETE),
        (["truth_sources", 0, "dialect"], "Postgres"),
        (["seeds", "reset_script"], "reset.sql"),
        (["seeds", "reset_script"], "/seeds/reset.sql"),
        (["seeds", "reset_script"], "seeds/../reset.sql"),
        (["seeds", "reset_script"], "seeds\reset.sql"),
        (["seeds", "reset_script"], "seeds/reset.txt"),
        (["seeds", "reset_script"], "seeds/.hidden.sql"),
        (["seeds", "fixtures"], ["fixtures.sql"]),
        (["seeds", "fixtures"], ["seeds/../fixtures.sql"]),
        (["seeds", "fixtures"], ["seeds"]),
        (["seeds", "expected_hash"], "short"),
        (["seeds", "expected_hash"], "has spaces in it"),
        (["seeds", "hash_command"], ""),
    ],
)
def test_invalid_optional_sections_are_rejected_by_both_validators(
    path: list[str | int], value: Any
) -> None:
    manifest = mutate(full_manifest(), path, value)
    assert not validator().is_valid(manifest)
    with pytest.raises(ValidationError):
        BundleManifest.model_validate(manifest)


def test_unknown_keys_inside_sections_are_kept_not_rejected() -> None:
    manifest = full_manifest()
    manifest["features"][0]["custom_note"] = "kept"
    manifest["app"]["owner_team"] = "guest-experience"
    manifest["interfaces"][0]["shapes"][0]["extra"] = {"a": 1}
    parsed = BundleManifest.model_validate(manifest)
    validator().validate(manifest)
    assert parsed.features[0].model_extra == {"custom_note": "kept"}
    assert parsed.app.model_extra == {"owner_team": "guest-experience"}
    dumped = parsed.model_dump(mode="json", by_alias=True)
    assert dumped["features"][0]["custom_note"] == "kept"


def test_unknown_top_level_keys_are_errors() -> None:
    document = published_schema()
    assert document["additionalProperties"] is False
    assert BundleManifest.model_config["extra"] == "forbid"


def test_optional_lists_default_to_empty_and_optional_sections_to_null() -> None:
    parsed = BundleManifest.model_validate(minimal_manifest())
    assert parsed.truth_sources == []
    assert parsed.invariants == []
    assert parsed.flags == []
    assert parsed.limitations == []
    assert parsed.data_model is None
    assert parsed.seeds is None
    assert parsed.test_hooks is None
    assert parsed.cleanup is None
    assert parsed.features[0].interfaces == []
    assert parsed.features[0].flag == "none"
    assert parsed.features[0].cleanup == "none"
    assert parsed.environment[0].required is True


def test_seeds_expected_hash_is_optional_and_hooks_missing_is_typed() -> None:
    manifest = full_manifest()
    del manifest["seeds"]["expected_hash"]
    parsed = BundleManifest.model_validate(manifest)
    assert parsed.seeds is not None
    assert parsed.seeds.expected_hash is None
    assert parsed.test_hooks is not None
    assert [hook.id for hook in parsed.test_hooks.missing] == ["pin_clock"]


def test_secret_defaults_to_true_so_a_forgotten_flag_never_exposes_a_value() -> None:
    parsed = BundleManifest.model_validate(minimal_manifest() | {"environment": [{"name": "X"}]})
    assert parsed.environment[0].secret is True


def test_every_plan_manifest_section_is_a_top_level_property() -> None:
    document = published_schema()
    assert set(document["properties"]) >= PLAN_SECTIONS
    assert {"schema", "target_token"} <= set(document["properties"])


def test_required_sections_are_the_ones_every_bundle_must_carry() -> None:
    assert set(published_schema()["required"]) == {
        "schema",
        "target_token",
        "app",
        "interfaces",
        "roles",
        "features",
        "environment",
    }


def test_features_are_typed_like_the_catalog_entry_of_the_plan() -> None:
    document = published_schema()
    feature = document["$defs"]["Feature"]
    assert set(feature["properties"]) == {
        "id",
        "area",
        "kind",
        "description",
        "interfaces",
        "roles",
        "flag",
        "preconditions",
        "examples",
        "invariants",
        "cleanup",
        "confidence",
        "writes_to",
        "confirmation",
        "expect_db",
    }
    assert set(feature["required"]) == {"id", "area", "kind", "description"}
    assert document["$defs"]["FeatureKind"]["enum"] == [kind.value for kind in FeatureKind]
    assert document["$defs"]["Confidence"]["enum"] == ["low", "medium", "high"]
    items = document["properties"]["features"]["items"]
    assert items == {"$ref": "#/$defs/Feature"}


def all_property_maps(document: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    maps = [("root", document["properties"])]
    maps.extend(
        (name, definition["properties"])
        for name, definition in document["$defs"].items()
        if "properties" in definition
    )
    return maps


def manifest_property_maps(document: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    return [
        (owner, properties)
        for owner, properties in all_property_maps(document)
        if owner != MUTANT_FORM_DEFINITION
    ]


def test_every_manifest_property_has_title_description_examples_and_ui_hints() -> None:
    document = published_schema()
    checked = 0
    for owner, properties in manifest_property_maps(document):
        for name, schema in properties.items():
            where = f"{owner}.{name}"
            assert schema.get("title"), where
            assert schema.get("description"), where
            assert isinstance(schema.get("examples"), list), where
            assert schema["examples"], where
            ui = schema["x-ui"]
            assert set(ui) == UI_KEYS, where
            assert ui["widget"] in UI_WIDGETS, where
            assert isinstance(ui["order"], int), where
            assert ui["group"], where
            assert ui["label"] == schema["title"], where
            checked += 1
    assert checked > 70


def test_the_mutants_sidecar_entries_are_the_published_mutant_form() -> None:
    bundle = published_schema()
    mutant: dict[str, Any] = json.loads(MUTANT_SCHEMA_PATH.read_text(encoding="utf-8"))
    entry = bundle["$defs"][MUTANT_FORM_DEFINITION]
    assert entry["properties"] == mutant["properties"]
    assert entry["required"] == mutant["required"]
    for name, definition in mutant["$defs"].items():
        assert bundle["$defs"][name] == definition, name
    for name, schema in entry["properties"].items():
        assert schema.get("title"), name
        assert schema.get("description"), name
        assert set(schema["x-ui"]) == UI_KEYS, name
        assert schema["x-ui"]["label"], name
        assert schema["x-ui"]["group"], name
        assert isinstance(schema["x-ui"]["order"], int), name


def test_ui_order_is_unique_inside_each_object() -> None:
    for owner, properties in all_property_maps(published_schema()):
        orders = [schema["x-ui"]["order"] for schema in properties.values()]
        assert len(orders) == len(set(orders)), owner


def test_every_example_is_valid_for_the_property_it_documents() -> None:
    document = published_schema()
    for owner, properties in all_property_maps(document):
        for name, schema in properties.items():
            standalone = {
                "$schema": document["$schema"],
                "$defs": document["$defs"],
                **{key: value for key, value in schema.items() if key != "examples"},
            }
            checker = Draft202012Validator(standalone)
            for example in schema.get("examples", []):
                assert checker.is_valid(example), f"{owner}.{name}: {example!r}"


def test_every_definition_carries_a_title_and_description() -> None:
    document = published_schema()
    for name, definition in document["$defs"].items():
        if "properties" in definition:
            assert definition["title"], name
            assert definition["description"], name


def test_the_registered_document_matches_the_committed_file() -> None:
    definition = next(item for item in SCHEMAS if item.name == "bundle")
    assert build_schema_document(definition) == published_schema()


def test_the_schema_url_example_points_at_the_bundle_schema() -> None:
    examples = published_schema()["properties"]["schema"]["examples"]
    assert all(example.endswith("/schemas/bundle.v1.json") for example in examples)
