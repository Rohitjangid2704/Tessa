import copy
from typing import Any

import pytest

from tessa_api.schemas.bundles import BundleCompleteness
from tessa_api.services.bundle_scorer import (
    CHECK_SPECS,
    TOTAL_WEIGHT,
    proportional_points,
    score_bundle,
)
from tessa_api.services.bundle_validator import BundleAnalysis, validate_bundle
from tessa_api.services.manifest_loader import load_manifest
from tests.bundle_fixtures import (
    DEFAULT_TARGET_TOKEN,
    Files,
    edit,
    gracie_like,
    minimal_valid,
    mutate_manifest,
    without,
)

BAR = 80
CONTRACT_WEIGHTS = {
    "required_sections": 20,
    "feature_interface_roles": 15,
    "feature_examples": 20,
    "oracle_read_only": 15,
    "env_template_coverage": 15,
    "seeds_reset_and_hash": 15,
}


def analyse(files: Files, files_available: bool = True) -> BundleAnalysis:
    loaded = load_manifest(files["manifest.yaml"].decode("utf-8"), 1024 * 1024)
    return validate_bundle(loaded, files, files_available, 1024 * 1024)


def score(files: Files, files_available: bool = True) -> BundleCompleteness:
    return score_bundle(analyse(files, files_available), BAR)


def earned(completeness: BundleCompleteness) -> dict[str, int]:
    return {check.id: check.earned for check in completeness.checks}


def gracie() -> Files:
    return gracie_like(DEFAULT_TARGET_TOKEN)


def test_weights_match_the_contract_and_sum_to_100() -> None:
    assert {spec.id: spec.weight for spec in CHECK_SPECS} == CONTRACT_WEIGHTS
    assert TOTAL_WEIGHT == 100
    assert [spec.id for spec in CHECK_SPECS] == list(CONTRACT_WEIGHTS)


def test_complete_bundle_scores_100_and_meets_the_bar() -> None:
    result = score(gracie())
    assert result.score == 100
    assert result.bar == BAR
    assert result.status.value == "meets_bar"
    assert all(check.passed and check.earned == check.weight for check in result.checks)
    assert all(check.fix_hint is None for check in result.checks)
    assert all(check.detail for check in result.checks)


def test_score_is_the_sum_of_earned_and_passed_means_full_credit() -> None:
    result = score(minimal_valid(DEFAULT_TARGET_TOKEN))
    assert result.score == sum(check.earned for check in result.checks) == 70
    assert result.status.value == "below_bar"
    for check in result.checks:
        assert 0 <= check.earned <= check.weight
        assert check.passed == (check.earned == check.weight)


def test_every_failed_check_has_a_hint() -> None:
    for files, available in (
        (minimal_valid(DEFAULT_TARGET_TOKEN), True),
        ({"manifest.yaml": gracie()["manifest.yaml"]}, False),
        ({"manifest.yaml": b"schema: x\ntarget_token: tgt_x\n"}, True),
    ):
        result = score(files, available)
        failed = [check for check in result.checks if not check.passed]
        assert failed
        assert all(check.fix_hint and check.detail for check in failed)


def test_pasted_manifest_scores_zero_on_checks_that_need_sibling_files() -> None:
    result = score({"manifest.yaml": gracie()["manifest.yaml"]}, files_available=False)
    points = earned(result)
    assert points["oracle_read_only"] == 0
    assert points["env_template_coverage"] == 0
    assert points["seeds_reset_and_hash"] == 0
    assert points["required_sections"] == 20
    assert result.score == 55
    assert result.status.value == "below_bar"
    assert "zip" in (result.checks[3].fix_hint or "")


@pytest.mark.parametrize(
    ("weight", "satisfied", "total", "expected"),
    [
        (15, 0, 4, 0),
        (15, 4, 4, 15),
        (15, 2, 4, 8),
        (15, 1, 4, 4),
        (20, 39, 40, 19),
        (15, 199, 200, 14),
        (20, 1, 1000, 0),
        (15, 5, 0, 0),
        (15, -1, 3, 0),
    ],
)
def test_proportional_points_never_reach_full_credit_early(
    weight: int, satisfied: int, total: int, expected: int
) -> None:
    assert proportional_points(weight, satisfied, total) == expected


def test_one_of_many_failing_costs_points_but_not_the_whole_check() -> None:
    def drop_one_example(document: dict[str, Any]) -> None:
        document["features"][1]["examples"] = []

    result = score(mutate_manifest(gracie(), drop_one_example))
    check = next(item for item in result.checks if item.id == "feature_examples")
    assert check.earned == 15
    assert not check.passed
    assert "smart_log.write.create_issue" in (check.fix_hint or "")
    assert "3 of 4" in (check.detail or "")


def test_features_without_interfaces_or_roles_are_listed_in_the_hint() -> None:
    def strip(document: dict[str, Any]) -> None:
        document["features"][0]["interfaces"] = []
        document["features"][2]["roles"] = []

    result = score(mutate_manifest(gracie(), strip))
    check = next(item for item in result.checks if item.id == "feature_interface_roles")
    assert check.earned == 8
    assert "smart_log.read.open_maintenance" in (check.fix_hint or "")
    assert "auth.login.staff" in (check.fix_hint or "")


def test_example_with_a_blank_expectation_does_not_count() -> None:
    def blank(document: dict[str, Any]) -> None:
        for example in document["features"][3]["examples"]:
            example["expected"] = "  "

    check = next(
        item
        for item in score(mutate_manifest(gracie(), blank)).checks
        if item.id == "feature_examples"
    )
    assert check.earned == 15


def test_missing_required_section_loses_proportional_points() -> None:
    def drop(document: dict[str, Any]) -> None:
        document.pop("features")
        document.pop("environment")

    result = score(mutate_manifest(gracie(), drop))
    required = next(item for item in result.checks if item.id == "required_sections")
    assert required.earned == round(20 * 5 / 7)
    assert "features" in (required.fix_hint or "")
    assert "environment" in (required.fix_hint or "")
    assert earned(result)["feature_examples"] == 0
    assert earned(result)["feature_interface_roles"] == 0


def test_unsafe_oracle_fails_the_oracle_check_with_the_reason() -> None:
    files = dict(gracie())
    files["oracle/open_maintenance.sql"] = b"DELETE FROM smart_log_issue"
    check = next(item for item in score(files).checks if item.id == "oracle_read_only")
    assert check.earned == 0
    assert "open_maintenance" in (check.fix_hint or "")


def test_half_of_the_oracles_failing_gives_half_the_points() -> None:
    files = dict(gracie())
    files["oracle/second.sql"] = b"DROP TABLE x"
    files["oracle/second.yaml"] = (
        b"name: second\nfeature_ids: [smart_log.read.open_maintenance]\nlanguage: sql\n"
        b"params_schema: {type: object, properties: {}}\nsentence_template: x\n"
    )
    check = next(item for item in score(files).checks if item.id == "oracle_read_only")
    assert check.earned == 8
    assert "second" in (check.fix_hint or "")


def test_missing_url_variable_or_truth_connection_lowers_env_coverage() -> None:
    files = edit(gracie(), "env.template", "TRUTH_DB_DSN=<read-only-postgres-dsn>", "OTHER=<x>")
    check = next(item for item in score(files).checks if item.id == "env_template_coverage")
    assert check.earned == 11
    assert "TRUTH_DB_DSN" in (check.fix_hint or "")
    assert "3 of 4" in (check.detail or "")


def test_missing_env_template_scores_zero_on_coverage() -> None:
    check = next(
        item
        for item in score(without(gracie(), "env.template")).checks
        if item.id == "env_template_coverage"
    )
    assert check.earned == 0
    assert "env.template" in (check.fix_hint or "")


def test_absolute_interface_base_path_needs_no_url_variable() -> None:
    def absolute(document: dict[str, Any]) -> None:
        document["interfaces"][2]["base_path"] = "https://admin.example.test/api"
        for variable in document["environment"]:
            variable["interfaces"] = [
                name for name in variable.get("interfaces", []) if name != "admin_api"
            ]

    check = next(
        item
        for item in score(mutate_manifest(gracie(), absolute)).checks
        if item.id == "env_template_coverage"
    )
    assert check.passed


def test_seeds_points_split_between_reset_script_and_hash_command() -> None:
    no_hash = mutate_manifest(gracie(), lambda document: document["seeds"].pop("hash_command"))
    check = next(item for item in score(no_hash).checks if item.id == "seeds_reset_and_hash")
    assert check.earned == 8
    assert "hash_command" in (check.fix_hint or "")
    no_script = without(gracie(), "seeds/reset.sql")
    check = next(item for item in score(no_script).checks if item.id == "seeds_reset_and_hash")
    assert check.earned == 7
    assert "reset_script" in (check.fix_hint or "")
    nothing = mutate_manifest(gracie(), lambda document: document.pop("seeds"))
    check = next(item for item in score(nothing).checks if item.id == "seeds_reset_and_hash")
    assert check.earned == 0


def test_scoring_does_not_depend_on_the_manifest_being_valid() -> None:
    def break_kind(document: dict[str, Any]) -> None:
        document["features"][0]["kind"] = "sideways"

    files = mutate_manifest(gracie(), break_kind)
    assert not analyse(files).valid
    assert score(files).score == 100

    def break_examples(document: dict[str, Any]) -> None:
        document["features"][0]["kind"] = "sideways"
        document["features"][0]["examples"] = []

    assert score(mutate_manifest(gracie(), break_examples)).score == 95


def test_score_is_deterministic_and_does_not_mutate_the_analysis() -> None:
    analysis = analyse(gracie())
    before = copy.deepcopy(analysis.data)
    first = score_bundle(analysis, BAR)
    second = score_bundle(analysis, BAR)
    assert first == second
    assert analysis.data == before


def test_status_follows_the_bar() -> None:
    analysis = analyse(minimal_valid(DEFAULT_TARGET_TOKEN))
    assert score_bundle(analysis, 70).status.value == "meets_bar"
    assert score_bundle(analysis, 71).status.value == "below_bar"
