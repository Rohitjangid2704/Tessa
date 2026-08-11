from typing import Any

import pytest
import yaml

from tessa_api.schemas.bundle_files import Flow
from tessa_api.services.scenario_validator import build_scenario_view, validate_scenario_text
from tessa_api.services.smoke_generator import (
    ExampleSource,
    FlowSource,
    build_smoke_view,
    chat_body,
    count_smoke_scenarios,
    document_hash,
    document_yaml,
    inject_ask,
    smoke_document,
    smoke_sources,
    strip_base_path,
)
from tests.bundle_examples import example_manifest, example_yaml

FEATURE = "smart_log.read.open_maintenance"


def gracie_flow() -> Flow:
    return Flow.model_validate(example_yaml("gracie", "flows/create_maintenance_issue.yaml"))


def gracie_view() -> Any:
    return build_smoke_view(example_manifest("gracie"), [gracie_flow()])


def environment_names() -> list[str]:
    return [variable["name"] for variable in example_manifest("gracie")["environment"]]


def generated(feature: str, role: str, interface: str, index: int = 0) -> dict[str, Any]:
    view = gracie_view()
    sources = smoke_sources(view, feature, role, interface)
    document = smoke_document(view, feature, "smart-log", role, interface, sources[index])
    assert document is not None
    return document


@pytest.mark.parametrize(
    ("path", "base", "expected"),
    [
        ("/api/admin/users", "/api/admin", "/users"),
        ("/api/admin", "/api/admin", "/"),
        ("/api/admin/", "/api/admin", "/"),
        ("/message", "/api/chat", "/message"),
        ("message", "/api/chat", "/message"),
        ("/api/adminx/users", "/api/admin", "/api/adminx/users"),
        ("/users", "/", "/users"),
        ("/users", "", "/users"),
        ("/users", "https://${HOST}/api", "/users"),
        ("/api/users?x=1", "/api", "/users?x=1"),
    ],
)
def test_the_interface_base_path_is_stripped_from_an_example_path(
    path: str, base: str, expected: str
) -> None:
    assert strip_base_path(path, base) == expected


@pytest.mark.parametrize(
    ("template", "expected"),
    [
        ({"message": "old"}, {"message": "Q"}),
        ({"text": "old", "lang": "en"}, {"text": "Q", "lang": "en"}),
        ({"lang": "en", "prompt": "old"}, {"lang": "en", "prompt": "Q"}),
        (
            {"messages": [{"role": "user", "content": "old"}]},
            {"messages": [{"role": "user", "content": "Q"}]},
        ),
        ({"session": {"input": "old"}}, {"session": {"input": "Q"}}),
        ("old", "Q"),
    ],
)
def test_the_ask_replaces_the_text_field_of_the_example_body(template: Any, expected: Any) -> None:
    replaced, done = inject_ask(template, "Q")
    assert done is True
    assert replaced == expected


def test_an_example_body_without_a_text_field_gets_a_message_field() -> None:
    shape = {"request_example": {"lang": "en", "n": 1}}
    assert chat_body(shape, "Q") == {"lang": "en", "n": 1, "message": "Q"}
    assert chat_body(None, "Q") == {"message": "Q"}
    assert chat_body({"request_example": None}, "Q") == {"message": "Q"}
    template = {"message": "old"}
    chat_body({"request_example": template}, "Q")
    assert template == {"message": "old"}


def test_the_sources_follow_the_interface_kind_and_the_cell() -> None:
    view = gracie_view()
    assert [type(s) for s in smoke_sources(view, FEATURE, "staff", "chat_sse")] == [
        ExampleSource,
        ExampleSource,
    ]
    assert smoke_sources(view, FEATURE, "staff", "browser") == []
    assert [
        type(s) for s in smoke_sources(view, "smart_log.write.create_issue", "staff", "browser")
    ] == [FlowSource]
    assert smoke_sources(view, "smart_log.write.create_issue", "manager", "browser") == []
    assert len(smoke_sources(view, "admin.users.list", "admin", "admin_api")) == 1
    assert smoke_sources(view, "auth.login.staff", "staff", "browser") == []
    assert smoke_sources(view, "ghost", "staff", "chat_sse") == []
    assert smoke_sources(view, FEATURE, "staff", "ghost") == []


def test_an_ask_example_becomes_an_sse_step_built_from_the_interface_shape() -> None:
    document = generated(FEATURE, "staff", "chat_sse")
    assert document["title"] == "Which maintenance issues are still open? (staff on chat_sse)"
    assert (document["role"], document["interface_id"], document["family"]) == (
        "staff",
        "chat_sse",
        "smart-log",
    )
    step = document["steps"][0]
    assert step["adapter"] == "sse"
    assert step["ask"] == "Which maintenance issues are still open?"
    assert step["request"] == {
        "method": "POST",
        "path": "/message",
        "body": {"message": "Which maintenance issues are still open?"},
    }
    expect = step["expect"]
    assert expect["status"] == 200
    assert expect["non_empty_answer"] is True
    assert expect["internal_ids"] is True
    assert expect["latency"] == {"max_first_byte_ms": 30000, "max_ms": 120000}
    assert expect["free_text"] == "count of open items and the rooms with the most, from the oracle"
    assert "text_contains" not in expect


def test_a_literal_text_contains_on_the_example_becomes_an_assertion() -> None:
    manifest = example_manifest("gracie")
    manifest["features"][0]["examples"][0]["text_contains"] = ["open", "rooms"]
    manifest["features"][0]["examples"][1]["text_contains"] = "one literal"
    view = build_smoke_view(manifest, [])
    first = smoke_document(
        view,
        FEATURE,
        "smart-log",
        "staff",
        "chat_sse",
        smoke_sources(view, FEATURE, "staff", "chat_sse")[0],
    )
    second = smoke_document(
        view,
        FEATURE,
        "smart-log",
        "staff",
        "chat_sse",
        smoke_sources(view, FEATURE, "staff", "chat_sse")[1],
    )
    assert first is not None
    assert second is not None
    assert first["steps"][0]["expect"]["text_contains"] == ["open", "rooms"]
    assert second["steps"][0]["expect"]["text_contains"] == ["one literal"]


def test_a_request_example_on_an_http_interface_becomes_an_http_step() -> None:
    document = generated("admin.users.list", "admin", "admin_api")
    step = document["steps"][0]
    assert step["adapter"] == "http"
    assert step["request"] == {"method": "GET", "path": "/users"}
    assert step["expect"]["status"] == [200, 201, 202, 204]
    assert step["expect"]["latency"] == {"max_ms": 10000}
    assert step["expect"]["free_text"] == "A page of users, never returning password hashes"
    assert step["label"] == "GET /users"


def test_a_request_example_on_an_sse_interface_keeps_its_own_request() -> None:
    manifest = example_manifest("gracie")
    manifest["features"][0]["examples"] = [
        {
            "request": {
                "method": "get",
                "path": "/api/chat/history",
                "headers": {"Accept": "text/event-stream"},
                "query": {"limit": 5},
            },
            "expected": "the history",
        }
    ]
    view = build_smoke_view(manifest, [])
    document = smoke_document(
        view,
        FEATURE,
        "smart-log",
        "staff",
        "chat_sse",
        smoke_sources(view, FEATURE, "staff", "chat_sse")[0],
    )
    assert document is not None
    step = document["steps"][0]
    assert step["adapter"] == "sse"
    assert step["request"] == {
        "method": "GET",
        "path": "/history",
        "headers": {"Accept": "text/event-stream"},
        "query": {"limit": 5},
    }
    assert "ask" not in step


def test_an_ask_example_on_an_http_interface_needs_a_shape_to_be_usable() -> None:
    manifest = example_manifest("gracie")
    manifest["features"][3]["examples"] = [{"ask": "How many users?", "expected": "a count"}]
    without_shape = build_smoke_view(manifest, [])
    assert smoke_sources(without_shape, "admin.users.list", "admin", "admin_api") == []
    manifest["interfaces"][2]["shapes"] = [
        {"name": "ask", "method": "POST", "path": "/ask", "request_example": {"question": "x"}}
    ]
    with_shape = build_smoke_view(manifest, [])
    source = smoke_sources(with_shape, "admin.users.list", "admin", "admin_api")[0]
    document = smoke_document(
        with_shape, "admin.users.list", "smart-log", "admin", "admin_api", source
    )
    assert document is not None
    assert document["steps"][0]["adapter"] == "http"
    assert document["steps"][0]["request"] == {
        "method": "POST",
        "path": "/ask",
        "body": {"question": "How many users?"},
    }


def test_a_bundle_flow_becomes_browser_steps_with_dom_state_and_a_console_check() -> None:
    document = generated("smart_log.write.create_issue", "staff", "browser")
    assert document["title"] == "Create a maintenance issue from the chat panel (staff on browser)"
    steps = document["steps"]
    assert len(steps) == 7
    assert all(step["adapter"] == "browser" for step in steps)
    assert steps[0]["action"] == "goto"
    assert steps[0]["url"] == "/login"
    assert steps[0]["expect"] == {"dom_state": {"url": "/login"}}
    assert steps[1]["target"] == {"role": "textbox", "name": "Email"}
    assert steps[1]["value"] == "${STAFF_EMAIL}"
    assert "expect" not in steps[1]
    assert steps[3]["expect"]["dom_state"] == {"url": "/", "text_contains": ["Smart Log"]}
    assert steps[4]["target"] == {"selector": "[data-testid=chat-input]"}
    assert steps[5]["value"] == "Enter"
    last = steps[6]["expect"]
    assert last["dom_state"] == {"text_contains": ["Issue created"]}
    assert last["console"] == {"fail_on": ["error"], "allow": ["favicon\\.ico"]}
    assert last["free_text"].startswith("Gracie asks for confirmation")
    assert "console" not in steps[0]["expect"]


def test_every_generated_document_validates_against_the_bundle_and_round_trips() -> None:
    view = gracie_view()
    scenario_view = build_scenario_view(example_manifest("gracie"), environment_names())
    cells = [
        (FEATURE, "staff", "chat_sse"),
        (FEATURE, "manager", "chat_sse"),
        ("smart_log.write.create_issue", "staff", "chat_sse"),
        ("smart_log.write.create_issue", "staff", "browser"),
        ("admin.users.list", "admin", "admin_api"),
    ]
    produced = 0
    for feature, role, interface in cells:
        for source in smoke_sources(view, feature, role, interface):
            document = smoke_document(view, feature, "smart-log", role, interface, source)
            assert document is not None
            check = validate_scenario_text(document_yaml(document), scenario_view)
            assert check.validation.errors == [], (feature, role, interface)
            assert check.parsed is not None
            again = validate_scenario_text(
                yaml.safe_dump(check.parsed, sort_keys=False), scenario_view
            )
            assert again.parsed == check.parsed
            produced += 1
    assert produced == 7


def test_a_placeholder_the_environment_lacks_makes_the_generated_scenario_invalid() -> None:
    view = gracie_view()
    names = [name for name in environment_names() if name != "STAFF_EMAIL"]
    scenario_view = build_scenario_view(example_manifest("gracie"), names)
    source = smoke_sources(view, "smart_log.write.create_issue", "staff", "browser")[0]
    document = smoke_document(
        view, "smart_log.write.create_issue", "smart-log", "staff", "browser", source
    )
    assert document is not None
    check = validate_scenario_text(document_yaml(document), scenario_view)
    assert [(issue.code, issue.pointer) for issue in check.validation.errors] == [
        ("unknown_environment_variable", "/steps/1/value")
    ]
    assert check.validation.errors[0].line is not None


def test_generation_is_deterministic_and_the_hash_follows_the_content() -> None:
    first = generated(FEATURE, "staff", "chat_sse")
    assert document_hash(first) == document_hash(generated(FEATURE, "staff", "chat_sse"))
    assert document_yaml(first) == document_yaml(generated(FEATURE, "staff", "chat_sse"))
    assert document_hash(first) != document_hash(generated(FEATURE, "staff", "chat_sse", 1))
    other_role = generated(FEATURE, "manager", "chat_sse")
    assert document_hash(first) != document_hash(other_role)


def test_the_estimate_counts_the_sources_of_each_cell() -> None:
    view = gracie_view()
    cells = [
        (FEATURE, "staff", "chat_sse"),
        (FEATURE, "staff", "browser"),
        ("smart_log.write.create_issue", "staff", "browser"),
        ("admin.users.list", "admin", "admin_api"),
    ]
    assert count_smoke_scenarios(view, cells) == 2 + 0 + 1 + 1


def test_a_step_label_and_title_stay_within_their_limits() -> None:
    manifest = example_manifest("gracie")
    manifest["features"][0]["examples"] = [{"ask": "word " * 200, "expected": "e"}]
    view = build_smoke_view(manifest, [])
    source = smoke_sources(view, FEATURE, "staff", "chat_sse")[0]
    document = smoke_document(view, FEATURE, "smart-log", "staff", "chat_sse", source)
    assert document is not None
    assert len(document["title"]) <= 200
    assert document["title"].endswith("… (staff on chat_sse)")
    assert len(document["steps"][0]["label"]) <= 200
    scenario_view = build_scenario_view(manifest, environment_names())
    assert validate_scenario_text(document_yaml(document), scenario_view).validation.valid
