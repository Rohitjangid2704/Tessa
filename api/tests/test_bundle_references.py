import copy
from collections.abc import Callable
from typing import Any

import pytest
from pydantic import ValidationError

from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.bundle_references import (
    STRUCTURE_ONLY_CONTEXT,
    find_reference_problems,
)
from tests.bundle_examples import example_manifest

Mutation = Callable[[dict[str, Any]], None]


def validation_failure(manifest: dict[str, Any]) -> ValidationError:
    with pytest.raises(ValidationError) as caught:
        BundleManifest.model_validate(manifest)
    return caught.value


def problems_of(manifest: dict[str, Any]) -> list[tuple[str, tuple[str | int, ...]]]:
    return [(error["type"], error["loc"]) for error in validation_failure(manifest).errors()]


def mutated(mutation: Mutation) -> dict[str, Any]:
    manifest = copy.deepcopy(example_manifest("gracie"))
    mutation(manifest)
    return manifest


def duplicate_feature(manifest: dict[str, Any]) -> None:
    manifest["features"].append(copy.deepcopy(manifest["features"][0]))


def duplicate_role(manifest: dict[str, Any]) -> None:
    manifest["roles"].append(copy.deepcopy(manifest["roles"][0]))


def duplicate_interface(manifest: dict[str, Any]) -> None:
    manifest["interfaces"].append(copy.deepcopy(manifest["interfaces"][0]))


def duplicate_variable(manifest: dict[str, Any]) -> None:
    manifest["environment"].append(copy.deepcopy(manifest["environment"][0]))


def duplicate_invariant(manifest: dict[str, Any]) -> None:
    manifest["invariants"].append(copy.deepcopy(manifest["invariants"][0]))


def duplicate_flag(manifest: dict[str, Any]) -> None:
    manifest["flags"].append(copy.deepcopy(manifest["flags"][0]))


def duplicate_truth_source(manifest: dict[str, Any]) -> None:
    manifest["truth_sources"].append(copy.deepcopy(manifest["truth_sources"][0]))


def duplicate_hook_across_lists(manifest: dict[str, Any]) -> None:
    manifest["test_hooks"]["missing"].append({"id": "health", "description": "again"})


def unknown_feature_interface(manifest: dict[str, Any]) -> None:
    manifest["features"][0]["interfaces"].append("carrier_pigeon")


def unknown_variable_interface(manifest: dict[str, Any]) -> None:
    manifest["environment"][0]["interfaces"].append("carrier_pigeon")


def unknown_feature_role(manifest: dict[str, Any]) -> None:
    manifest["features"][1]["roles"] = ["staff", "janitor"]


def unknown_feature_flag(manifest: dict[str, Any]) -> None:
    manifest["features"][0]["flag"] = "new_checkout"


def unknown_role_credential(manifest: dict[str, Any]) -> None:
    manifest["roles"][0]["credential_env"] = "NOBODY_TOKEN"


def unknown_truth_connection(manifest: dict[str, Any]) -> None:
    manifest["truth_sources"][0]["connection_env"] = "OTHER_DSN"


def unknown_seed_connection(manifest: dict[str, Any]) -> None:
    manifest["seeds"]["dsn_env"] = "OTHER_DSN"


def seed_connection_equals_truth_connection(manifest: dict[str, Any]) -> None:
    manifest["seeds"]["dsn_env"] = "TRUTH_DB_DSN"


def undeclared_placeholder(manifest: dict[str, Any]) -> None:
    manifest["app"]["how_to_run"] = "BASE=${UNDECLARED_URL} npm start"


def lowercase_placeholder(manifest: dict[str, Any]) -> None:
    manifest["features"][0]["examples"][0]["ask"] = "Open ${base_url}"


def placeholder_in_nested_example(manifest: dict[str, Any]) -> None:
    manifest["interfaces"][0]["shapes"][0]["request_example"] = {
        "headers": [{"Authorization": "Bearer ${MISSING_TOKEN}"}]
    }


REFERENCE_CASES: list[tuple[Mutation, str, tuple[str | int, ...]]] = [
    (duplicate_feature, "duplicate_id", ("features", 4, "id")),
    (duplicate_role, "duplicate_id", ("roles", 3, "id")),
    (duplicate_interface, "duplicate_id", ("interfaces", 3, "id")),
    (duplicate_variable, "duplicate_id", ("environment", 8, "name")),
    (duplicate_invariant, "duplicate_id", ("invariants", 5, "id")),
    (duplicate_flag, "duplicate_id", ("flags", 1, "id")),
    (duplicate_truth_source, "duplicate_id", ("truth_sources", 1, "id")),
    (duplicate_hook_across_lists, "duplicate_id", ("test_hooks", "missing", 2, "id")),
    (unknown_feature_interface, "unknown_interface", ("features", 0, "interfaces", 2)),
    (unknown_variable_interface, "unknown_interface", ("environment", 0, "interfaces", 3)),
    (unknown_feature_role, "unknown_role", ("features", 1, "roles", 1)),
    (unknown_feature_flag, "unknown_flag", ("features", 0, "flag")),
    (unknown_role_credential, "unknown_environment_variable", ("roles", 0, "credential_env")),
    (
        unknown_truth_connection,
        "unknown_environment_variable",
        ("truth_sources", 0, "connection_env"),
    ),
    (unknown_seed_connection, "unknown_environment_variable", ("seeds", "dsn_env")),
    (seed_connection_equals_truth_connection, "seed_dsn_shared_with_truth", ("seeds", "dsn_env")),
    (undeclared_placeholder, "undeclared_placeholder", ("app", "how_to_run")),
    (lowercase_placeholder, "invalid_placeholder", ("features", 0, "examples", 0, "ask")),
    (
        placeholder_in_nested_example,
        "undeclared_placeholder",
        ("interfaces", 0, "shapes", 0, "request_example", "headers", 0, "Authorization"),
    ),
]


@pytest.mark.parametrize(
    ("mutation", "code", "loc"),
    REFERENCE_CASES,
    ids=[mutation.__name__ for mutation, _, _ in REFERENCE_CASES],
)
def test_each_broken_reference_is_one_error_with_its_code_and_location(
    mutation: Mutation, code: str, loc: tuple[str | int, ...]
) -> None:
    assert problems_of(mutated(mutation)) == [(code, loc)]


def test_a_manifest_with_several_broken_references_reports_all_of_them_at_once() -> None:
    def break_many(manifest: dict[str, Any]) -> None:
        unknown_feature_interface(manifest)
        unknown_feature_role(manifest)
        undeclared_placeholder(manifest)
        duplicate_role(manifest)

    codes = sorted(code for code, _ in problems_of(mutated(break_many)))
    assert codes == ["duplicate_id", "undeclared_placeholder", "unknown_interface", "unknown_role"]


def test_error_messages_name_the_offending_value_and_say_how_to_fix_it() -> None:
    errors = validation_failure(mutated(unknown_feature_role)).errors()
    assert len(errors) == 1
    assert "'janitor'" in errors[0]["msg"]
    assert "'all'" in errors[0]["msg"]
    placeholder_error = validation_failure(mutated(undeclared_placeholder)).errors()[0]
    assert "${UNDECLARED_URL}" in placeholder_error["msg"]
    assert placeholder_error["input"] == "${UNDECLARED_URL}"


def test_structure_only_parsing_leaves_reference_problems_to_the_caller() -> None:
    manifest = mutated(unknown_feature_role)
    parsed = BundleManifest.model_validate(manifest, context=STRUCTURE_ONLY_CONTEXT)
    problems = find_reference_problems(parsed)
    assert [(problem.code, problem.loc) for problem in problems] == [
        ("unknown_role", ("features", 1, "roles", 1))
    ]
    assert problems[0].value == "janitor"


def test_structure_only_parsing_still_rejects_a_broken_structure() -> None:
    manifest = mutated(lambda document: document["features"][0].pop("id"))
    with pytest.raises(ValidationError):
        BundleManifest.model_validate(manifest, context=STRUCTURE_ONLY_CONTEXT)


def test_a_valid_manifest_has_no_reference_problems() -> None:
    parsed = BundleManifest.model_validate(example_manifest("gracie"))
    assert find_reference_problems(parsed) == []


def test_shell_style_expansions_that_are_not_placeholders_are_left_alone() -> None:
    manifest = mutated(
        lambda document: document["app"].update(
            how_to_run="PORT=${PORT:-8080} npm start && echo $HOME ${a.b} ${ }"
        )
    )
    BundleManifest.model_validate(manifest)


def test_placeholders_in_keys_and_non_text_values_are_not_scanned() -> None:
    manifest = mutated(
        lambda document: document["interfaces"][0]["shapes"][0].update(
            request_example={"${NOT_A_VALUE}": 1, "count": 3}
        )
    )
    BundleManifest.model_validate(manifest)


def test_declared_placeholders_resolve_everywhere_they_are_used() -> None:
    manifest = mutated(
        lambda document: document["features"][0]["examples"][0].update(
            ask="Log in as ${STAFF_EMAIL} on ${GRACIE_BASE_URL}"
        )
    )
    BundleManifest.model_validate(manifest)


def test_the_error_location_of_a_nested_check_is_the_manifest_pointer() -> None:
    manifest = mutated(lambda document: document["environment"][3].update(secret=False))
    errors = validation_failure(manifest).errors()
    assert [(error["type"], error["loc"]) for error in errors] == [
        ("secret_required_for_kind", ("environment", 3, "secret"))
    ]


@pytest.mark.parametrize("kind", ["dsn", "token", "password"])
def test_credential_kinds_cannot_be_declared_non_secret(kind: str) -> None:
    manifest = mutated(
        lambda document: document["environment"].append(
            {"name": "EXTRA_VALUE", "kind": kind, "secret": False}
        )
    )
    assert problems_of(manifest) == [("secret_required_for_kind", ("environment", 8, "secret"))]


@pytest.mark.parametrize("kind", ["url", "string", "number", "bool"])
def test_other_kinds_may_be_non_secret(kind: str) -> None:
    manifest = mutated(
        lambda document: document["environment"].append(
            {"name": "EXTRA_VALUE", "kind": kind, "secret": False}
        )
    )
    BundleManifest.model_validate(manifest)


def test_a_database_truth_source_must_declare_its_dialect() -> None:
    manifest = mutated(lambda document: document["truth_sources"][0].pop("dialect"))
    assert problems_of(manifest) == [("dialect_required", ("truth_sources", 0, "dialect"))]


def test_a_read_endpoint_truth_source_needs_no_dialect() -> None:
    manifest = mutated(
        lambda document: document["truth_sources"][0].update(kind="read_endpoint", dialect=None)
    )
    BundleManifest.model_validate(manifest)


def test_a_sql_reset_script_needs_a_connection_variable() -> None:
    manifest = mutated(lambda document: document["seeds"].pop("dsn_env"))
    assert problems_of(manifest) == [("seed_dsn_required", ("seeds", "dsn_env"))]


@pytest.mark.parametrize("script", ["seeds/reset.py", "seeds/reset.sh"])
def test_script_reset_scripts_do_not_need_a_connection_variable(script: str) -> None:
    def use_script_without_connection(document: dict[str, Any]) -> None:
        del document["seeds"]["dsn_env"]
        document["seeds"]["reset_script"] = script

    BundleManifest.model_validate(mutated(use_script_without_connection))


@pytest.mark.parametrize(
    ("section", "empty"),
    [("interfaces", []), ("roles", []), ("features", []), ("environment", [])],
)
def test_the_required_lists_cannot_be_empty(section: str, empty: list[Any]) -> None:
    manifest = mutated(lambda document: document.update({section: empty}))
    errors = validation_failure(manifest).errors()
    assert (errors[0]["type"], errors[0]["loc"]) == ("too_short", (section,))
