import pytest

from tessa_api.schemas.scenario import BrowserStep, BrowserTarget
from tessa_worker.adapters.browser_steps import (
    StepFailure,
    console_level,
    exact_selector,
    navigation_url,
    normalise_text,
    origin_of,
    page_shows,
    partial_selector,
    request_action,
    same_origin,
    step_label,
)


def browser_step(action: str, **fields: object) -> BrowserStep:
    return BrowserStep.model_validate({"adapter": "browser", "action": action, **fields})


def test_a_selector_target_is_used_as_written() -> None:
    target = BrowserTarget(selector="[data-testid=send]")
    assert exact_selector(target) == "[data-testid=send]"
    assert partial_selector(target) is None


def test_a_role_target_is_matched_exactly_first_and_by_substring_second() -> None:
    target = BrowserTarget(role="button", name="Sign in")
    assert exact_selector(target) == 'role=button[name="Sign in"]'
    assert partial_selector(target) == r"role=button[name=/Sign\ in/i]"


def test_hidden_elements_are_included_on_request() -> None:
    target = BrowserTarget(role="alert", name="Oops")
    assert exact_selector(target, include_hidden=True).endswith("[include-hidden]")
    assert (partial_selector(target, include_hidden=True) or "").endswith("[include-hidden]")


def test_names_are_quoted_and_escaped_so_they_cannot_break_the_selector() -> None:
    backslash = chr(92)
    target = BrowserTarget(role="link", name=f'say "hi" / back{backslash}slash  (now)')
    expected = f'role=link[name="say {backslash}"hi{backslash}" / back{backslash * 2}slash (now)"]'
    assert exact_selector(target) == expected
    partial = partial_selector(target) or ""
    assert "/ back" not in partial
    assert f"{backslash}/{backslash} back" in partial
    assert partial.endswith("/i]")


@pytest.mark.parametrize("role", ["", "button name", "but]ton", "role=x", "Button1"])
def test_a_role_that_is_not_an_aria_word_is_refused(role: str) -> None:
    target = BrowserTarget.model_construct(role=role, name="x", selector=None)
    with pytest.raises(StepFailure):
        exact_selector(target)


def test_actions_map_onto_the_request_vocabulary() -> None:
    assert request_action(browser_step("goto", url="/")) == "navigate"
    assert request_action(browser_step("press", value="Enter")) == "press"
    assert request_action(browser_step("wait_for", expect={"dom_state": {"url": "/"}})) == "wait"
    for action in ("click", "check", "hover"):
        assert request_action(browser_step(action, target={"selector": "#a"})) == "click"
    for action in ("fill", "select"):
        assert request_action(browser_step(action, target={"selector": "#a"}, value="v")) == "type"


def test_labels_describe_the_step() -> None:
    assert step_label(browser_step("goto", url="/login")) == "goto /login"
    assert step_label(browser_step("press", value="Enter")) == "press Enter"
    assert (
        step_label(browser_step("click", target={"role": "button", "name": "Go"}))
        == "click role=button name=Go"
    )
    assert step_label(browser_step("goto", url="/x", label="Open the form")) == "Open the form"


def test_navigation_joins_a_path_to_the_interface_and_keeps_absolute_addresses() -> None:
    assert navigation_url("http://app.test", "/login") == "http://app.test/login"
    assert navigation_url("http://app.test/", "login") == "http://app.test/login"
    assert navigation_url("http://app.test/app", "/x") == "http://app.test/app/x"
    assert navigation_url("http://app.test", "https://other.test/y") == "https://other.test/y"


def test_origins_compare_scheme_host_and_port() -> None:
    assert origin_of("HTTP://Host.test:80/path?q=1") == "http://host.test:80"
    assert same_origin("http://a.test:1/x", "http://a.test:1/y")
    assert not same_origin("http://a.test:1/x", "http://a.test:2/x")
    assert not same_origin("http://a.test/x", "https://a.test/x")


def test_console_levels_follow_the_contract_words() -> None:
    assert console_level("warning") == "warning"
    assert console_level("error") == "error"
    assert console_level("assert") == "error"
    assert console_level("log") == "log"


def test_page_text_is_compared_without_case_and_spacing() -> None:
    page = normalise_text("Rooms\n\n  Open   issues: 3 ")
    assert page_shows(page, "open issues: 3")
    assert page_shows(page, "ROOMS open")
    assert not page_shows(page, "closed issues")
