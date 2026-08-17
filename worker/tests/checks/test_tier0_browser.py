import pytest
from pydantic import JsonValue

from tessa_api.schemas.enums import Tier0Check
from tessa_worker.checks.page_checks import url_matches
from tessa_worker.checks.tier0 import evaluate_tier0
from tests.checks.support import CONTEXT, browser_expect, browser_record, checks_of


@pytest.mark.parametrize(
    ("actual", "expected", "matches"),
    [
        ("http://t/chat", "/chat", True),
        ("http://t/chat/", "/chat", True),
        ("http://t/chat", "/chat/", True),
        ("http://t/app/chat", "/chat", True),
        ("http://t/chat?x=1", "/chat", True),
        ("http://t/chatty", "/chat", False),
        ("http://t/login", "/chat", False),
        ("http://t/", "/", True),
        ("http://t", "/", True),
        ("http://t/chat", "/", False),
        ("http://t/rooms?floor=2", "/rooms?floor=2", True),
        ("http://t/rooms?floor=3", "/rooms?floor=2", False),
        ("http://t/rooms", "/rooms?floor=2", False),
        ("http://t/chat", "http://t/chat", True),
        ("http://t/chat/", "http://t/chat", True),
        ("http://t/chat", "http://other/chat", False),
    ],
)
def test_page_url_matching(actual: str, expected: str, matches: bool) -> None:
    assert url_matches(actual, expected) is matches


@pytest.mark.parametrize(
    ("expected_url", "passes"), [("/chat", True), ("/login", False), (None, True)]
)
def test_dom_state_url_truth_table(expected_url: str | None, passes: bool) -> None:
    dom: dict[str, JsonValue] = {"title_contains": "Chat"}
    if expected_url is not None:
        dom["url"] = expected_url
    result = evaluate_tier0(browser_record(), browser_expect(dom_state=dom), CONTEXT)
    assert result.passed is passes
    assert set(checks_of(result.failures)) <= {Tier0Check.dom_state}


@pytest.mark.parametrize(
    ("title", "wanted", "passes"),
    [
        ("Fake Target - Chat", "Chat", True),
        ("Fake Target - Chat", "chat", True),
        ("Fake Target - Chat", "Login", False),
        (None, "Chat", False),
        ("", "Chat", False),
    ],
)
def test_dom_state_title_truth_table(title: str | None, wanted: str, passes: bool) -> None:
    result = evaluate_tier0(
        browser_record(title=title),
        browser_expect(dom_state={"title_contains": wanted}),
        CONTEXT,
    )
    assert result.passed is passes


@pytest.mark.parametrize(
    ("observed", "wanted", "passes"),
    [
        ({"Issue created": True}, ["Issue created"], True),
        ({"Issue created": False}, ["Issue created"], False),
        ({}, ["Issue created"], False),
        ({"A": True, "B": True}, ["A", "B"], True),
        ({"A": True, "B": False}, ["A", "B"], False),
    ],
)
def test_dom_state_text_contains_truth_table(
    observed: dict[str, bool], wanted: list[str], passes: bool
) -> None:
    result = evaluate_tier0(
        browser_record(text_found=observed),
        browser_expect(dom_state={"text_contains": wanted}),
        CONTEXT,
    )
    assert result.passed is passes
    assert set(checks_of(result.failures)) <= {Tier0Check.dom_state}


@pytest.mark.parametrize(
    ("observed", "forbidden", "passes"),
    [
        ({"Error": False}, ["Error"], True),
        ({"Error": True}, ["Error"], False),
        ({}, ["Error"], False),
    ],
)
def test_dom_state_text_not_contains_truth_table(
    observed: dict[str, bool], forbidden: list[str], passes: bool
) -> None:
    result = evaluate_tier0(
        browser_record(text_found=observed),
        browser_expect(dom_state={"text_not_contains": forbidden}),
        CONTEXT,
    )
    assert result.passed is passes


def test_unobserved_text_says_so_instead_of_claiming_it_is_missing() -> None:
    result = evaluate_tier0(
        browser_record(observed=False), browser_expect(dom_state={"text_contains": ["x"]}), CONTEXT
    )
    assert "not observed" in result.failures[0].message
    present = evaluate_tier0(
        browser_record(text_found={"x": False}),
        browser_expect(dom_state={"text_contains": ["x"]}),
        CONTEXT,
    )
    assert "does not show" in present.failures[0].message


@pytest.mark.parametrize(
    ("state", "visible", "hidden", "passes"),
    [
        ("visible", True, False, True),
        ("hidden", True, False, False),
        ("missing", True, False, False),
        ("hidden", False, True, True),
        ("missing", False, True, True),
        ("visible", False, True, False),
    ],
)
def test_dom_state_elements_truth_table(
    state: str, visible: bool, hidden: bool, passes: bool
) -> None:
    key = "role=button name=Confirm"
    target: dict[str, JsonValue] = {"role": "button", "name": "Confirm"}
    dom: dict[str, JsonValue] = {}
    if visible:
        dom["visible"] = [target]
    if hidden:
        dom["hidden"] = [target]
    result = evaluate_tier0(
        browser_record(elements={key: state}), browser_expect(dom_state=dom), CONTEXT
    )
    assert result.passed is passes


def test_elements_are_keyed_by_selector_or_by_role_and_name() -> None:
    elements = {"selector=[data-testid=send]": "visible", "role=button name=Send": "visible"}
    dom: dict[str, JsonValue] = {
        "visible": [{"selector": "[data-testid=send]"}, {"role": "button", "name": "Send"}]
    }
    assert evaluate_tier0(
        browser_record(elements=elements), browser_expect(dom_state=dom), CONTEXT
    ).passed


def test_an_element_that_was_not_observed_fails_with_that_reason() -> None:
    result = evaluate_tier0(
        browser_record(observed=False),
        browser_expect(dom_state={"visible": [{"selector": "#x"}]}),
        CONTEXT,
    )
    assert result.failures[0].actual == "not observed"


@pytest.mark.parametrize(
    ("messages", "console", "passes"),
    [
        ([], {"fail_on": ["error"]}, True),
        ([("log", "hello")], {"fail_on": ["error"]}, True),
        ([("info", "chat ready")], {"fail_on": ["error", "warning"]}, True),
        ([("error", "boom")], {"fail_on": ["error"]}, False),
        ([("warning", "careful")], {"fail_on": ["error"]}, True),
        ([("warning", "careful")], {"fail_on": ["error", "warning"]}, False),
        ([("warn", "careful")], {"fail_on": ["warning"]}, False),
        ([("ERROR", "boom")], {"fail_on": ["error"]}, False),
        ([("error", "favicon.ico 404")], {"fail_on": ["error"], "allow": ["favicon"]}, True),
        ([("error", "boom")], {"fail_on": ["error"], "allow": ["favicon"]}, False),
        (
            [("error", "favicon 404"), ("error", "boom")],
            {"fail_on": ["error"], "allow": ["favicon"]},
            False,
        ),
        ([("error", "boom")], {}, False),
    ],
)
def test_console_truth_table(
    messages: list[tuple[str, str]], console: dict[str, JsonValue], passes: bool
) -> None:
    result = evaluate_tier0(
        browser_record(console=messages), browser_expect(console=console), CONTEXT
    )
    assert result.passed is passes
    assert set(checks_of(result.failures)) <= {Tier0Check.console}


def test_a_console_failure_quotes_the_message() -> None:
    [failure] = evaluate_tier0(
        browser_record(console=[("error", "Uncaught TypeError: x is undefined")]),
        browser_expect(console={"fail_on": ["error"]}),
        CONTEXT,
    ).failures
    assert "Uncaught TypeError" in failure.message
    assert failure.actual == "Uncaught TypeError: x is undefined"


def test_at_most_five_console_messages_are_listed_and_the_rest_are_counted() -> None:
    messages = [("error", f"boom {index}") for index in range(8)]
    failures = evaluate_tier0(
        browser_record(console=messages), browser_expect(console={"fail_on": ["error"]}), CONTEXT
    ).failures
    assert len(failures) == 6
    assert "3 more" in failures[-1].message


def test_an_invalid_console_allow_pattern_is_reported_not_raised() -> None:
    [failure] = evaluate_tier0(
        browser_record(console=[("error", "x")]),
        browser_expect(console={"fail_on": ["error"], "allow": ["("]}),
        CONTEXT,
    ).failures
    assert failure.check is Tier0Check.console
    assert "invalid" in failure.message


def test_without_expectations_a_browser_step_passes_whatever_the_console_says() -> None:
    result = evaluate_tier0(browser_record(console=[("error", "boom")]), browser_expect(), CONTEXT)
    assert result.passed is True


def test_a_step_the_adapter_could_not_complete_fails_the_dom_state_check() -> None:
    record = browser_record(ok=False, error="element not found: button Send", with_response=False)
    result = evaluate_tier0(record, browser_expect(console={"fail_on": ["error"]}), CONTEXT)
    assert checks_of(result.failures) == [Tier0Check.dom_state]
    assert "element not found" in result.failures[0].message


def test_a_failed_step_with_a_page_still_checks_the_console_and_the_state() -> None:
    record = browser_record(ok=False, error="timeout waiting for text", console=[("error", "boom")])
    expect = browser_expect(console={"fail_on": ["error"]}, dom_state={"url": "/login"})
    result = evaluate_tier0(record, expect, CONTEXT)
    assert checks_of(result.failures) == [
        Tier0Check.console,
        Tier0Check.dom_state,
        Tier0Check.dom_state,
    ]
