import re
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from tessa_api.schemas.bundle import (
    ENV_TEMPLATE_LINE_PATTERN,
    BundleManifest,
)
from tessa_api.schemas.bundle_files import Flow, OracleSidecar
from tests.bundle_examples import EXAMPLE_NAMES, example_manifest, example_text, example_yaml
from tests.test_bundle_schema import published_schema

SQL_PARAMETER = re.compile(r"(?<![:\w]):([a-z_][a-z0-9_]*)")


def definition_validator(name: str) -> Draft202012Validator:
    document = published_schema()
    return Draft202012Validator(
        {"$schema": document["$schema"], "$defs": document["$defs"], "$ref": f"#/$defs/{name}"}
    )


def env_template_assignments(text: str) -> dict[str, str]:
    assignments: dict[str, str] = {}
    pending_purpose: str | None = None
    for line in text.splitlines():
        if not line.strip():
            pending_purpose = None
        elif line.startswith("#"):
            pending_purpose = line.removeprefix("#").strip()
        else:
            match = re.fullmatch(ENV_TEMPLATE_LINE_PATTERN, line)
            assert match is not None, line
            purpose = match.group(4) or pending_purpose
            assert purpose, f"{match.group(1)} has no purpose"
            assignments[match.group(1)] = purpose
            pending_purpose = None
    return assignments


@pytest.mark.parametrize("example", EXAMPLE_NAMES)
def test_example_manifests_are_valid_in_pydantic_and_in_the_published_schema(
    example: str,
) -> None:
    manifest = example_manifest(example)
    parsed = BundleManifest.model_validate(manifest)
    Draft202012Validator(published_schema()).validate(manifest)
    assert parsed.features


def test_the_gracie_example_covers_the_plan_catalog_entry_and_every_section() -> None:
    parsed = BundleManifest.model_validate(example_manifest("gracie"))
    feature = next(item for item in parsed.features if item.id == "smart_log.read.open_maintenance")
    assert feature.area == "Smart Log"
    assert feature.interfaces == ["chat_sse", "browser"]
    assert feature.roles == ["all"]
    assert feature.examples[0].oracle == "open_maintenance"
    assert feature.invariants == ["no_internal_ids", "count_matches_oracle", "empty_set_honesty"]
    assert parsed.app.kind.value == "llm_assistant"
    assert parsed.data_model is not None
    assert parsed.seeds is not None
    assert parsed.seeds.expected_hash is None
    assert parsed.test_hooks is not None
    assert [hook.id for hook in parsed.test_hooks.missing] == ["pin_clock", "flush_cache"]
    assert parsed.cleanup is not None
    assert len(parsed.truth_sources) == 1
    assert len(parsed.invariants) == 5
    assert len(parsed.flags) == 1


def test_the_gracie_oracle_sidecar_is_valid_and_matches_its_sql_and_the_manifest() -> None:
    sidecar_document = example_yaml("gracie", "oracle/open_maintenance.yaml")
    sidecar = OracleSidecar.model_validate(sidecar_document)
    definition_validator("OracleSidecar").validate(sidecar_document)
    manifest = BundleManifest.model_validate(example_manifest("gracie"))
    assert {feature.id for feature in manifest.features} >= set(sidecar.feature_ids)
    assert sidecar.truth_source in {source.id for source in manifest.truth_sources}
    sql = example_text("gracie", "oracle/open_maintenance.sql")
    assert set(SQL_PARAMETER.findall(sql)) == set(sidecar.params_schema["properties"])
    assert [point.key for point in sidecar.gold_points] == ["open_rooms", "top_room"]
    assert any(
        example.oracle == sidecar.name
        for feature in manifest.features
        for example in feature.examples
    )


def test_the_gracie_flow_is_valid_and_refers_to_declared_ids_and_variables() -> None:
    flow_document = example_yaml("gracie", "flows/create_maintenance_issue.yaml")
    flow = Flow.model_validate(flow_document)
    definition_validator("Flow").validate(flow_document)
    manifest = BundleManifest.model_validate(example_manifest("gracie"))
    assert flow.role in {role.id for role in manifest.roles}
    assert set(flow.feature_ids) <= {feature.id for feature in manifest.features}
    assert flow.steps[0].action == "goto"
    assert flow.steps[1].target is not None
    assert flow.steps[1].target.role == "textbox"
    assert flow.steps[4].target is not None
    assert flow.steps[4].target.selector == "[data-testid=chat-input]"


def test_the_gracie_env_template_matches_the_declared_environment_exactly() -> None:
    manifest = BundleManifest.model_validate(example_manifest("gracie"))
    assignments = env_template_assignments(example_text("gracie", "env.template"))
    assert set(assignments) == {variable.name for variable in manifest.environment}


def test_the_gracie_seed_files_exist_where_the_manifest_points() -> None:
    manifest = BundleManifest.model_validate(example_manifest("gracie"))
    assert manifest.seeds is not None
    assert manifest.seeds.reset_script is not None
    assert example_text("gracie", manifest.seeds.reset_script)
    assert manifest.seeds.hash_command is not None
    assert example_text("gracie", manifest.seeds.hash_command.removeprefix("bash "))


def test_the_published_env_template_example_follows_its_own_grammar() -> None:
    definition: dict[str, Any] = published_schema()["$defs"]["EnvTemplate"]
    assert definition["x-line-pattern"] == ENV_TEMPLATE_LINE_PATTERN
    assignments = env_template_assignments(definition["examples"][0])
    assert set(assignments) == {"GRACIE_BASE_URL", "ADMIN_TOKEN"}
    assert assignments["GRACIE_BASE_URL"] == "Base URL of the QA deployment"
    assert assignments["ADMIN_TOKEN"] == "API token of the admin role"
