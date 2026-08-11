import copy
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from tessa_api.schemas.bundles import BundleValidationError
from tessa_api.services.bundle_validator import BundleAnalysis, validate_bundle
from tessa_api.services.manifest_loader import load_manifest
from tests.bundle_fixtures import (
    BUNDLES_ROOT,
    DEFAULT_TARGET_TOKEN,
    Files,
    edit,
    gracie_like,
    minimal_valid,
    mutate_manifest,
    without,
)

GOLDEN_ROOT = BUNDLES_ROOT / "golden"
MANIFEST_LIMIT = 1024 * 1024


def analyse(
    files: Mapping[str, bytes],
    files_available: bool = True,
    parse_limit: int = MANIFEST_LIMIT,
) -> BundleAnalysis:
    loaded = load_manifest(files["manifest.yaml"].decode("utf-8"), MANIFEST_LIMIT)
    return validate_bundle(loaded, files, files_available, parse_limit)


def error_codes(analysis: BundleAnalysis) -> list[str]:
    return sorted({error.code for error in analysis.errors})


def warning_codes(analysis: BundleAnalysis) -> list[str]:
    return sorted({warning.code for warning in analysis.warnings})


def problem_of(problems: list[BundleValidationError], code: str) -> BundleValidationError:
    matching = [problem for problem in problems if problem.code == code]
    assert matching, f"no {code} in {[problem.code for problem in problems]}"
    return matching[0]


def gracie() -> Files:
    return gracie_like(DEFAULT_TARGET_TOKEN)


def test_the_gracie_bundle_is_valid_without_warnings() -> None:
    analysis = analyse(gracie())
    assert analysis.errors == []
    assert analysis.warnings == []
    assert analysis.valid
    assert analysis.manifest is not None
    assert set(analysis.oracles) == {"open_maintenance"}
    assert analysis.oracles["open_maintenance"].ok
    assert analysis.flow_count == 1
    assert analysis.env_template is not None
    assert "TRUTH_DB_DSN" in analysis.env_template.names


def test_the_minimal_bundle_is_valid_and_has_no_oracles_or_flows() -> None:
    analysis = analyse(minimal_valid(DEFAULT_TARGET_TOKEN))
    assert analysis.valid
    assert analysis.warnings == []
    assert analysis.oracles == {}
    assert analysis.flow_count == 0


def test_a_pasted_manifest_is_valid_without_file_checks() -> None:
    files = {"manifest.yaml": gracie()["manifest.yaml"]}
    analysis = analyse(files, files_available=False)
    assert analysis.valid
    assert analysis.warnings == []
    assert analysis.env_template is None
    assert analysis.oracles == {}


def test_manifest_without_sibling_files_in_a_zip_warns() -> None:
    analysis = analyse({"manifest.yaml": gracie()["manifest.yaml"]})
    assert "oracle_file_missing" in error_codes(analysis)
    assert {"env_template_missing", "readme_missing"} <= set(warning_codes(analysis))


def test_yaml_syntax_error_is_reported_with_position() -> None:
    files = edit(gracie(), "manifest.yaml", "app:\n", "app: [\n")
    analysis = analyse(files)
    assert not analysis.valid
    assert analysis.manifest is None
    error = analysis.errors[0]
    assert error.code == "yaml_syntax"
    assert error.line is not None


def test_schema_errors_carry_pointer_and_line() -> None:
    files = edit(gracie(), "manifest.yaml", "kind: read\n", "kind: sideways\n")
    analysis = analyse(files)
    error = problem_of(analysis.errors, "enum")
    assert error.pointer == "/features/0/kind"
    assert error.file == "manifest.yaml"
    assert error.line is not None
    assert analysis.manifest is None
    assert not analysis.valid


def test_unknown_top_level_key_is_an_error() -> None:
    files = mutate_manifest(gracie(), lambda document: document.update({"bogus": 1}))
    analysis = analyse(files)
    error = problem_of(analysis.errors, "extra_forbidden")
    assert error.pointer == "/bogus"


def test_cross_references_are_reported_at_their_pointers() -> None:
    def break_references(document: dict[str, Any]) -> None:
        document["features"][0]["interfaces"].append("carrier_pigeon")
        document["features"][1]["roles"] = ["janitor"]
        document["features"][2]["flag"] = "mystery"
        document["roles"][0]["credential_env"] = "NOT_DECLARED"

    analysis = analyse(mutate_manifest(gracie(), break_references))
    codes = {(error.code, error.pointer) for error in analysis.errors}
    assert ("unknown_interface", "/features/0/interfaces/2") in codes
    assert ("unknown_role", "/features/1/roles/0") in codes
    assert ("unknown_flag", "/features/2/flag") in codes
    assert ("unknown_environment_variable", "/roles/0/credential_env") in codes


def test_seed_connection_shared_with_truth_is_an_error() -> None:
    files = edit(gracie(), "manifest.yaml", "dsn_env: SEED_DB_DSN", "dsn_env: TRUTH_DB_DSN")
    assert "seed_dsn_shared_with_truth" in error_codes(analyse(files))


def test_undeclared_placeholder_in_the_manifest_is_an_error() -> None:
    files = edit(
        gracie(), "manifest.yaml", "${ADMIN_TOKEN}\n    health", "${ADMIN_TOKN}\n    health"
    )
    assert "undeclared_placeholder" in error_codes(analyse(files))


def test_environment_variable_missing_from_the_template_is_a_warning() -> None:
    files = edit(gracie(), "env.template", "SMART_LOG_TENANT_ID=<qa-property-id>", "OTHER_NAME=<x>")
    analysis = analyse(files)
    assert analysis.valid
    missing = problem_of(analysis.warnings, "env_template_missing_variable")
    assert "SMART_LOG_TENANT_ID" in missing.message
    assert missing.file == "manifest.yaml"
    assert missing.pointer is not None
    assert "env_template_unknown_variable" in warning_codes(analysis)


def test_placeholder_without_a_template_line_is_an_error_with_a_line() -> None:
    files = edit(gracie(), "env.template", "STAFF_EMAIL=staff@example.test\n", "")
    analysis = analyse(files)
    error = problem_of(analysis.errors, "placeholder_not_in_env_template")
    assert "STAFF_EMAIL" in error.message
    assert error.line is not None
    assert not analysis.valid


def test_invalid_template_line_is_an_error() -> None:
    files = edit(gracie(), "env.template", "ADMIN_TOKEN=<admin-api-token>", "ADMIN TOKEN = x y")
    error = problem_of(analyse(files).errors, "env_template_invalid_line")
    assert error.file == "env.template"
    assert error.line is not None


def test_url_example_with_credentials_is_an_error_and_with_a_path_a_warning() -> None:
    credentials = edit(
        gracie(), "env.template", "http://localhost:8080", "http://user:pw@localhost:8080"
    )
    assert "url_with_credentials" in error_codes(analyse(credentials))
    path = edit(gracie(), "env.template", "http://localhost:8080", "http://localhost:8080/api")
    analysis = analyse(path)
    assert analysis.valid
    assert "url_example_has_path" in warning_codes(analysis)


def test_interface_without_a_url_variable_is_a_warning() -> None:
    def unlink(document: dict[str, Any]) -> None:
        for variable in document["environment"]:
            variable["interfaces"] = [
                name for name in variable.get("interfaces", []) if name != "admin_api"
            ]

    analysis = analyse(mutate_manifest(gracie(), unlink))
    assert analysis.valid
    warning = problem_of(analysis.warnings, "interface_without_url_variable")
    assert "admin_api" in warning.message


def test_seed_files_must_exist() -> None:
    analysis = analyse(without(gracie(), "seeds/reset.sql"))
    error = problem_of(analysis.errors, "seed_file_missing")
    assert error.pointer == "/seeds/reset_script"


def test_cited_oracle_without_files_is_an_error_at_the_citation() -> None:
    files = without(
        without(gracie(), "oracle/open_maintenance.yaml"), "oracle/open_maintenance.sql"
    )
    analysis = analyse(files)
    error = problem_of(analysis.errors, "oracle_file_missing")
    assert error.pointer == "/features/0/examples/0/oracle"
    assert error.line is not None
    assert not analysis.oracles["open_maintenance"].ok


def test_oracle_source_missing_for_the_declared_language() -> None:
    analysis = analyse(without(gracie(), "oracle/open_maintenance.sql"))
    error = problem_of(analysis.errors, "oracle_source_missing")
    assert error.file == "oracle/open_maintenance.yaml"
    assert error.pointer == "/language"
    assert analysis.oracles["open_maintenance"].reasons


def test_uncited_oracle_source_without_a_sidecar_is_a_warning() -> None:
    files = dict(gracie())
    files["oracle/extra.sql"] = b"select 1"
    analysis = analyse(files)
    assert analysis.valid
    assert "oracle_sidecar_missing" in warning_codes(analysis)
    assert not analysis.oracles["extra"].ok


@pytest.mark.parametrize(
    ("statement", "code"),
    [
        ("DELETE FROM smart_log_issue", "oracle_not_read_only"),
        ("SELECT 1; DROP TABLE smart_log_issue", "oracle_multiple_statements"),
        ("SELECT pg_read_file('/etc/passwd')", "oracle_forbidden_function"),
        ("SELECT * INTO copy_of FROM smart_log_issue", "oracle_select_into"),
        ("SELECT * FROM smart_log_issue FOR UPDATE", "oracle_row_lock"),
        ("SELECT * FROM", "oracle_sql_unparseable"),
    ],
)
def test_unsafe_oracle_sql_invalidates_the_bundle(statement: str, code: str) -> None:
    files = dict(gracie())
    files["oracle/open_maintenance.sql"] = statement.encode()
    analysis = analyse(files)
    assert not analysis.valid
    error = problem_of(analysis.errors, code)
    assert error.file == "oracle/open_maintenance.sql"
    assert not analysis.oracles["open_maintenance"].ok


def test_query_parameters_must_be_declared_in_the_sidecar() -> None:
    files = edit(gracie(), "oracle/open_maintenance.sql", ":today", ":today AND x = :floor")
    error = problem_of(analyse(files).errors, "oracle_param_undeclared")
    assert ":floor" in error.message


def test_declared_but_unused_parameter_is_a_warning() -> None:
    files = edit(gracie(), "oracle/open_maintenance.sql", "AND i.created_at < :today", "")
    analysis = analyse(files)
    assert analysis.valid
    warning = problem_of(analysis.warnings, "oracle_param_unused")
    assert warning.pointer == "/params_schema/properties/today"


def test_unknown_dialect_fails_closed() -> None:
    files = edit(gracie(), "manifest.yaml", "dialect: postgres", "dialect: klingon")
    error = problem_of(analyse(files).errors, "oracle_dialect_unknown")
    assert error.file == "oracle/open_maintenance.sql"


def test_sidecar_must_match_the_manifest() -> None:
    files = edit(gracie(), "oracle/open_maintenance.yaml", "name: open_maintenance", "name: other")
    assert "oracle_name_mismatch" in error_codes(analyse(files))
    files = edit(
        gracie(), "oracle/open_maintenance.yaml", "[smart_log.read.open_maintenance]", "[nope.x]"
    )
    assert "unknown_feature" in error_codes(analyse(files))
    files = edit(
        gracie(), "oracle/open_maintenance.yaml", "truth_source: primary_db", "truth_source: nope"
    )
    assert "unknown_truth_source" in error_codes(analyse(files))


def test_oracle_without_truth_source_needs_exactly_one_declared() -> None:
    sidecar_without_source = edit(
        gracie(), "oracle/open_maintenance.yaml", "truth_source: primary_db\n", ""
    )
    assert analyse(sidecar_without_source).valid

    def add_second_source(document: dict[str, Any]) -> None:
        document["truth_sources"].append(
            {
                "id": "replica_db",
                "kind": "database",
                "connection_env": "REPLICA_DB_DSN",
                "dialect": "postgres",
            }
        )
        document["environment"].append(
            {
                "name": "REPLICA_DB_DSN",
                "kind": "dsn",
                "secret": True,
                "required": False,
                "purpose": "Read replica",
            }
        )

    files = mutate_manifest(sidecar_without_source, add_second_source)
    files["env.template"] += b"# Read replica\nREPLICA_DB_DSN=<read-only-postgres-dsn>\n"
    analysis = analyse(files)
    assert "truth_source_required" in error_codes(analysis)


def test_sql_oracle_on_a_read_endpoint_is_an_error() -> None:
    def read_endpoint(document: dict[str, Any]) -> None:
        document["truth_sources"][0]["kind"] = "read_endpoint"
        document["truth_sources"][0].pop("dialect")

    analysis = analyse(mutate_manifest(gracie(), read_endpoint))
    assert "oracle_source_not_database" in error_codes(analysis)


def test_sidecar_yaml_with_an_alias_is_rejected() -> None:
    files = dict(gracie())
    files["oracle/open_maintenance.yaml"] = (
        b"base: &b {type: string}\nname: open_maintenance\nparams_schema: *b\n"
    )
    analysis = analyse(files)
    error = problem_of(analysis.errors, "yaml_alias_rejected")
    assert error.file == "oracle/open_maintenance.yaml"


def test_python_oracle_is_checked_for_run() -> None:
    files = edit(gracie(), "oracle/open_maintenance.yaml", "language: sql", "language: python")
    files = {
        name: content for name, content in files.items() if name != "oracle/open_maintenance.sql"
    }
    good = dict(files)
    good["oracle/open_maintenance.py"] = b"def run(params, connect):\n    return []\n"
    assert analyse(good).valid
    bad = dict(files)
    bad["oracle/open_maintenance.py"] = b"def other():\n    return []\n"
    error = problem_of(analyse(bad).errors, "oracle_python_no_run")
    assert error.file == "oracle/open_maintenance.py"


def test_flow_files_are_cross_checked() -> None:
    path = "flows/create_maintenance_issue.yaml"
    assert "flow_id_mismatch" in error_codes(
        analyse(edit(gracie(), path, "id: create_maintenance_issue", "id: other"))
    )
    assert "unknown_feature" in error_codes(
        analyse(edit(gracie(), path, "[smart_log.write.create_issue]", "[nope.x]"))
    )
    assert "unknown_role" in error_codes(
        analyse(edit(gracie(), path, "role: staff", "role: janitor"))
    )
    assert "undeclared_placeholder" in error_codes(
        analyse(edit(gracie(), path, "${STAFF_EMAIL}", "${STAFF_MAIL}"))
    )
    assert analyse(edit(gracie(), path, "role: staff", "role: anonymous")).valid


def test_flow_with_a_bad_step_reports_a_pointer() -> None:
    path = "flows/create_maintenance_issue.yaml"
    files = edit(gracie(), path, "    url: /login\n", "")
    error = problem_of(analyse(files).errors, "step_url_required")
    assert error.file == path
    assert error.line is not None


def test_placeholders_in_other_files_warn_when_undeclared_and_error_when_not_in_template() -> None:
    files = dict(gracie())
    files["README.md"] = b"Set ${UNDECLARED_THING} first.\n"
    analysis = analyse(files)
    assert analysis.valid
    assert "placeholder_not_declared" in warning_codes(analysis)
    shell = edit(gracie(), "seeds/hash.sh", "${TRUTH_DB_DSN}", "${SEED_DB_DSN}")
    assert analyse(shell).valid
    without_line = edit(shell, "env.template", "SEED_DB_DSN=<write-postgres-dsn>", "")
    assert "placeholder_not_in_env_template" in error_codes(analyse(without_line))


def test_unreadable_openapi_is_a_warning() -> None:
    files = dict(gracie())
    files["openapi.json"] = b"{not json"
    analysis = analyse(files)
    assert analysis.valid
    assert "openapi_unreadable" in warning_codes(analysis)


def test_reported_problems_are_capped() -> None:
    def many_bad_features(document: dict[str, Any]) -> None:
        document["features"] = [
            {"id": f"f{index}", "area": "A", "kind": "nope", "description": "d"}
            for index in range(400)
        ]

    analysis = analyse(mutate_manifest(gracie(), many_bad_features))
    assert len(analysis.errors) == 100


def test_structured_files_over_the_parse_limit_are_not_read() -> None:
    analysis = analyse(gracie(), parse_limit=300)
    codes = error_codes(analysis)
    assert "file_too_large_to_check" in codes
    files = {error.file for error in analysis.errors if error.code == "file_too_large_to_check"}
    assert files == {
        "oracle/open_maintenance.yaml",
        "flows/create_maintenance_issue.yaml",
    }
    assert not analysis.oracles["open_maintenance"].ok
    assert "too large" in analysis.oracles["open_maintenance"].reasons[0]


def test_oracle_source_over_the_parse_limit_is_not_read() -> None:
    files = dict(gracie())
    files["oracle/open_maintenance.sql"] = b"SELECT 1 -- " + b"x" * 2000
    analysis = analyse(files, parse_limit=1500)
    assert {error.file for error in analysis.errors} >= {"oracle/open_maintenance.sql"}
    assert "file_too_large_to_check" in error_codes(analysis)


def test_total_parse_budget_stops_a_bundle_of_many_flows() -> None:
    files = dict(gracie())
    template = files["flows/create_maintenance_issue.yaml"]
    for number in range(30):
        files[f"flows/flow_{number}.yaml"] = template.replace(
            b"id: create_maintenance_issue", f"id: flow_{number}".encode()
        )
    analysis = analyse(files, parse_limit=len(template) + 10)
    assert "bundle_too_large_to_check" in error_codes(analysis)


def golden_snapshot(analysis: BundleAnalysis) -> dict[str, Any]:
    def row(problem: BundleValidationError) -> dict[str, Any]:
        return {
            "code": problem.code,
            "severity": problem.severity,
            "file": problem.file,
            "pointer": problem.pointer,
            "line": problem.line,
            "column": problem.column,
        }

    return {
        "valid": analysis.valid,
        "errors": [row(error) for error in analysis.errors],
        "warnings": [row(warning) for warning in analysis.warnings],
    }


def broken_references() -> Files:
    def mutation(document: dict[str, Any]) -> None:
        document["features"][0]["interfaces"].append("carrier_pigeon")
        document["features"][1]["roles"] = ["janitor"]
        document["features"][2]["flag"] = "mystery"
        document["roles"][0]["credential_env"] = "NOT_DECLARED"
        document["features"].append(copy.deepcopy(document["features"][3]))

    return mutate_manifest(gracie(), mutation)


def broken_files() -> Files:
    files = edit(gracie(), "oracle/open_maintenance.sql", ":today", ":today AND x = :floor")
    files = edit(files, "env.template", "STAFF_EMAIL=staff@example.test\n", "")
    files = edit(files, "flows/create_maintenance_issue.yaml", "role: staff", "role: janitor")
    files["README.md"] = b"Run with ${UNDECLARED_THING}.\n"
    return without(files, "seeds/reset.sql")


def broken_oracles() -> Files:
    files = dict(gracie())
    files["oracle/open_maintenance.sql"] = b"SELECT 1; DROP TABLE smart_log_issue"
    files["oracle/stray.sql"] = b"SELECT pg_read_file('/etc/passwd')"
    files["oracle/stray.yaml"] = (
        b"name: stray\nfeature_ids: [nope]\nlanguage: sql\n"
        b"params_schema: {type: object, properties: {}}\nsentence_template: x\n"
    )
    return files


GOLDEN_CASES = {
    "broken_references": broken_references,
    "broken_files": broken_files,
    "broken_oracles": broken_oracles,
}


@pytest.mark.parametrize("name", sorted(GOLDEN_CASES))
def test_validation_output_matches_the_golden_file(name: str) -> None:
    snapshot = golden_snapshot(analyse(GOLDEN_CASES[name]()))
    golden = json.loads((GOLDEN_ROOT / f"{name}.json").read_text(encoding="utf-8"))
    assert snapshot == golden


def write_golden_files(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name, build in GOLDEN_CASES.items():
        snapshot = golden_snapshot(analyse(build()))
        (directory / f"{name}.json").write_text(
            json.dumps(snapshot, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
