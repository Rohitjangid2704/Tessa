from pathlib import Path
from typing import Any

import pytest
import yaml

from tessa_api.schemas.enums import AdapterKind, OracleApproval
from tessa_api.services.scenario_truth_checks import OracleView
from tessa_api.services.scenario_validator import (
    MAX_SCENARIO_BYTES,
    STEP_KINDS_BY_INTERFACE_KIND,
    ScenarioBundleView,
    build_scenario_view,
    validate_scenario_text,
)
from tests.support import API_ROOT

FIXTURES = API_ROOT / "tests" / "fixtures" / "scenarios"
ENVIRONMENT = (
    "STAFF_EMAIL",
    "STAFF_PASSWORD",
    "ADMIN_TOKEN",
    "ROOM_ID",
)


def manifest() -> dict[str, Any]:
    return {
        "roles": [
            {"id": "staff"},
            {"id": "manager"},
            {"id": "admin"},
            {"id": "owner"},
            {"id": "viewer"},
        ],
        "interfaces": [
            {"id": "chat_sse", "kind": "sse"},
            {"id": "web_ui", "kind": "browser"},
            {"id": "admin_api", "kind": "http"},
            {"id": "live", "kind": "websocket"},
        ],
        "features": [
            {
                "id": "smart_log.read.open_maintenance",
                "interfaces": ["chat_sse", "web_ui"],
                "roles": ["all"],
            },
            {"id": "rooms.read.list", "interfaces": ["admin_api"], "roles": ["admin"]},
            {"id": "documents.read.policies", "interfaces": ["chat_sse"], "roles": ["owner"]},
            {"id": "calendar.write.create_event", "interfaces": ["chat_sse"], "roles": ["owner"]},
        ],
    }


@pytest.fixture
def view() -> ScenarioBundleView:
    return build_scenario_view(manifest(), ENVIRONMENT)


def validate(text: str, view: ScenarioBundleView) -> Any:
    return validate_scenario_text(text, view)


def codes(issues: Any) -> list[str]:
    return [issue.code for issue in issues]


def document(**overrides: Any) -> str:
    base: dict[str, Any] = {
        "schema_version": 1,
        "title": "Staff asks",
        "feature_id": "smart_log.read.open_maintenance",
        "family": "smart-log",
        "role": "staff",
        "interface_id": "chat_sse",
        "steps": [
            {
                "adapter": "sse",
                "ask": "Which issues are open?",
                "request": {"method": "POST", "path": "/message", "body": {"message": "Hi"}},
                "expect": {"status": 200},
            }
        ],
    }
    return yaml.safe_dump({**base, **overrides}, sort_keys=False)


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.yaml")), ids=lambda path: path.stem)
def test_every_fixture_scenario_validates_against_a_matching_bundle(
    path: Path, view: ScenarioBundleView
) -> None:
    check = validate(path.read_text(encoding="utf-8"), view)
    assert check.validation.errors == []
    assert check.validation.valid is True
    assert check.document is not None
    assert check.parsed is not None
    assert check.parsed["schema_version"] == 1


def test_a_valid_scenario_returns_the_normalised_document(view: ScenarioBundleView) -> None:
    check = validate(document(), view)
    assert check.validation.valid is True
    assert check.validation.warnings == []
    assert check.parsed is not None
    assert check.parsed["role"] == "staff"
    assert check.parsed["synthetic"] is False
    step = check.parsed["steps"][0]
    assert step["expect"]["internal_ids"] is True
    assert "free_text" not in step["expect"]


def test_the_normalised_document_validates_again_to_the_same_document(
    view: ScenarioBundleView,
) -> None:
    first = validate(document(), view)
    assert first.parsed is not None
    second = validate(yaml.safe_dump(first.parsed, sort_keys=False), view)
    assert second.parsed == first.parsed


def test_an_unknown_role_interface_and_feature_are_each_reported_with_a_pointer(
    view: ScenarioBundleView,
) -> None:
    check = validate(document(role="ghost", interface_id="nowhere", feature_id="nope.read.x"), view)
    assert check.validation.valid is False
    by_code = {issue.code: issue for issue in check.validation.errors}
    assert by_code["unknown_role"].pointer == "/role"
    assert by_code["unknown_interface"].pointer == "/interface_id"
    assert by_code["unknown_feature"].pointer == "/feature_id"
    assert by_code["unknown_role"].line == 5
    assert by_code["unknown_role"].column == 1


def test_every_interface_kind_is_drivable_but_only_by_its_own_step_kinds(
    view: ScenarioBundleView,
) -> None:
    assert set(STEP_KINDS_BY_INTERFACE_KIND) == set(AdapterKind)
    check = validate(document(interface_id="live"), view)
    assert view.interface_kinds["live"] is AdapterKind.websocket
    assert "interface_kind_unsupported" not in codes(check.validation.errors)
    unsupported = [
        issue for issue in check.validation.errors if issue.code == "step_kind_unsupported"
    ]
    assert [issue.pointer for issue in unsupported] == ["/steps/0/adapter"]
    assert "A sse step cannot run on interface 'live' of kind websocket" in unsupported[0].message


def test_a_step_kind_must_be_supported_by_the_interface_kind(view: ScenarioBundleView) -> None:
    browser_step = [{"adapter": "browser", "action": "goto", "url": "/login"}]
    check = validate(document(steps=browser_step), view)
    issue = next(i for i in check.validation.errors if i.code == "step_kind_unsupported")
    assert issue.pointer == "/steps/0/adapter"
    assert "sse" in issue.message
    http_on_sse = [{"adapter": "http", "request": {"method": "GET", "path": "/history"}}]
    assert validate(document(steps=http_on_sse), view).validation.valid is True
    sse_on_http = [{"adapter": "sse", "request": {"method": "GET", "path": "/s"}}]
    mismatch = validate(document(interface_id="admin_api", steps=sse_on_http), view)
    assert "step_kind_unsupported" in codes(mismatch.validation.errors)
    http_on_browser = [{"adapter": "http", "request": {"method": "GET", "path": "/s"}}]
    mismatch = validate(document(interface_id="web_ui", steps=http_on_browser), view)
    assert "step_kind_unsupported" in codes(mismatch.validation.errors)


def test_every_placeholder_must_exist_in_the_target_environment(view: ScenarioBundleView) -> None:
    steps = [
        {
            "adapter": "http",
            "request": {
                "method": "GET",
                "path": "/rooms/${ROOM_ID}",
                "headers": {"Authorization": "Bearer ${MISSING_TOKEN}", "X-Lower": "${lower_case}"},
            },
        }
    ]
    check = validate(document(interface_id="admin_api", role="admin", steps=steps), view)
    by_pointer = {issue.pointer: issue for issue in check.validation.errors}
    assert (
        by_pointer["/steps/0/request/headers/Authorization"].code == "unknown_environment_variable"
    )
    assert "MISSING_TOKEN" in by_pointer["/steps/0/request/headers/Authorization"].message
    assert by_pointer["/steps/0/request/headers/X-Lower"].code == "invalid_placeholder"
    assert "/steps/0/request/path" not in by_pointer


def test_a_gold_reference_is_not_mistaken_for_an_environment_placeholder() -> None:
    oracle = OracleView(
        name="open_maintenance",
        approval=OracleApproval.approved,
        params_schema={"type": "object", "properties": {}},
        gold_keys=frozenset({"open_count"}),
    )
    with_oracle = build_scenario_view(manifest(), ENVIRONMENT, [oracle])
    steps = [
        {
            "adapter": "sse",
            "request": {"method": "GET", "path": "/s"},
            "gold_from": {"oracle": "open_maintenance"},
            "expect": {"text_contains": ["${gold.open_count} rooms"]},
        }
    ]
    check = validate(document(steps=steps), with_oracle)
    assert check.validation.errors == []
    assert check.validation.valid is True


def test_the_step_identity_must_be_anonymous_or_a_declared_role(view: ScenarioBundleView) -> None:
    steps = [
        {"adapter": "sse", "as": "anonymous", "request": {"method": "GET", "path": "/s"}},
        {"adapter": "sse", "as": "viewer", "request": {"method": "GET", "path": "/s"}},
        {"adapter": "sse", "as": "stranger", "request": {"method": "GET", "path": "/s"}},
    ]
    check = validate(document(steps=steps), view)
    assert [(i.code, i.pointer) for i in check.validation.errors] == [
        ("unknown_role", "/steps/2/as")
    ]


def test_anonymous_is_not_a_scenario_role_unless_the_bundle_declares_it(
    view: ScenarioBundleView,
) -> None:
    check = validate(document(role="anonymous"), view)
    assert "unknown_role" in codes(check.validation.errors)


def test_a_feature_that_does_not_list_the_role_or_interface_only_warns(
    view: ScenarioBundleView,
) -> None:
    check = validate(
        document(feature_id="rooms.read.list", role="staff", interface_id="chat_sse"), view
    )
    assert check.validation.valid is True
    assert codes(check.validation.warnings) == [
        "interface_not_listed_for_feature",
        "role_not_listed_for_feature",
    ]


def test_yaml_syntax_errors_carry_line_and_column(view: ScenarioBundleView) -> None:
    check = validate("title: [unclosed\nrole: staff\n", view)
    assert check.validation.valid is False
    assert check.document is None
    error = check.validation.errors[0]
    assert error.code == "yaml_syntax"
    assert error.line is not None
    assert error.column is not None


def test_a_duplicate_key_and_an_alias_are_rejected(view: ScenarioBundleView) -> None:
    duplicate = validate("title: a\ntitle: b\n" + document(), view)
    assert "duplicate_key" in codes(duplicate.validation.errors)
    aliased = validate("base: &a 1\ncopy: *a\n", view)
    assert codes(aliased.validation.errors) == ["yaml_alias_rejected"]


def test_a_document_that_is_not_a_mapping_is_rejected(view: ScenarioBundleView) -> None:
    check = validate("- a\n- b\n", view)
    assert codes(check.validation.errors) == ["root_not_a_mapping"]


def test_model_errors_point_at_the_exact_key_with_line_and_column(
    view: ScenarioBundleView,
) -> None:
    text = (
        "schema_version: 1\n"
        "title: T\n"
        "family: f\n"
        "role: staff\n"
        "interface_id: chat_sse\n"
        "colour: red\n"
        "steps:\n"
        "  - adapter: sse\n"
        "    request:\n"
        "      method: POST\n"
        "      path: no-leading-slash\n"
        "    expect:\n"
        "      status: 99\n"
    )
    check = validate(text, view)
    by_pointer = {issue.pointer: issue for issue in check.validation.errors}
    assert by_pointer["/colour"].code == "extra_forbidden"
    assert (by_pointer["/colour"].line, by_pointer["/colour"].column) == (6, 1)
    assert by_pointer["/steps/0/request/path"].code == "string_pattern_mismatch"
    assert by_pointer["/steps/0/request/path"].line == 11
    assert by_pointer["/steps/0/request/path"].column == 7
    assert "/steps/0/expect/status" in by_pointer
    assert not any("sse" in (issue.pointer or "") for issue in check.validation.errors)
    assert not any("/int" in (issue.pointer or "") for issue in check.validation.errors)


def test_a_missing_required_key_is_reported_at_its_would_be_pointer(
    view: ScenarioBundleView,
) -> None:
    check = validate("schema_version: 1\ntitle: T\nfamily: f\nrole: staff\nsteps: []\n", view)
    pointers = {issue.pointer: issue for issue in check.validation.errors}
    assert pointers["/interface_id"].code == "missing"
    assert pointers["/interface_id"].line == 1
    assert "/steps" in pointers


def test_a_missing_key_inside_a_step_is_located_through_the_step_union(
    view: ScenarioBundleView,
) -> None:
    text = (
        "schema_version: 1\ntitle: T\nfamily: f\nrole: staff\ninterface_id: chat_sse\n"
        "steps:\n  - adapter: sse\n    ask: hello\n"
    )
    check = validate(text, view)
    assert [(issue.code, issue.pointer) for issue in check.validation.errors] == [
        ("missing", "/steps/0/request")
    ]
    assert check.validation.errors[0].line == 7


def test_a_cell_that_disagrees_with_the_header_is_an_error(view: ScenarioBundleView) -> None:
    check = validate(document(cell={"role": "manager", "interface_id": "chat_sse"}), view)
    assert "cell_mismatch" in codes(check.validation.errors)
    assert check.validation.errors[0].pointer == "/cell"


def test_an_oversized_document_is_refused_before_it_is_parsed(view: ScenarioBundleView) -> None:
    check = validate_scenario_text("a: " + "x" * 200, view, max_bytes=100)
    assert codes(check.validation.errors) == ["scenario_too_large"]
    assert MAX_SCENARIO_BYTES > 100_000


def test_the_error_list_is_capped(view: ScenarioBundleView) -> None:
    steps = [
        {"adapter": "sse", "as": f"stranger{index}", "request": {"method": "GET", "path": "/s"}}
        for index in range(150)
    ]
    check = validate(document(steps=steps), view)
    assert len(check.validation.errors) == 100


def test_a_bundle_without_a_manifest_gives_an_empty_view_and_fails_cleanly() -> None:
    empty = build_scenario_view(None, [])
    check = validate_scenario_text(document(), empty)
    assert {"unknown_role", "unknown_interface", "unknown_feature"} <= set(
        codes(check.validation.errors)
    )
