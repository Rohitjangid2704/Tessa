import re
from urllib.parse import urlsplit

from pydantic import JsonValue

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.scenario import BrowserExpect, ConsoleExpect, DomStateExpect
from tessa_api.schemas.steps import BrowserStepResponse, Tier0Failure
from tessa_worker.adapters.base import StepRecord
from tessa_worker.checks.common import SAMPLE_LIMIT, adapter_failure, failure, in_check_order

ABSOLUTE_PREFIXES = ("http://", "https://")


def url_matches(actual: str, expected: str) -> bool:
    if expected.lower().startswith(ABSOLUTE_PREFIXES):
        return actual.rstrip("/") == expected.rstrip("/")
    actual_parts = urlsplit(actual)
    expected_parts = urlsplit(expected)
    wanted_path = expected_parts.path.rstrip("/")
    actual_path = actual_parts.path.rstrip("/")
    path_matches = actual_path == "" if wanted_path == "" else actual_path.endswith(wanted_path)
    return path_matches and (not expected_parts.query or actual_parts.query == expected_parts.query)


def normalise_level(level: str) -> str:
    lowered = level.lower()
    return "warning" if lowered == "warn" else lowered


def console_failures(response: BrowserStepResponse, expect: ConsoleExpect) -> list[Tier0Failure]:
    try:
        allowed = [re.compile(pattern) for pattern in expect.allow]
    except re.error:
        return [failure(Tier0Check.console, "an allow pattern of the console check is invalid")]
    failing_levels = set(expect.fail_on)
    offending = [
        message
        for message in response.console
        if normalise_level(message.level) in failing_levels
        and not any(pattern.search(message.text) for pattern in allowed)
    ]
    failures = [
        failure(
            Tier0Check.console,
            f"the browser console showed a {normalise_level(message.level)}: {message.text}",
            "no console messages of level " + "/".join(expect.fail_on),
            message.text,
        )
        for message in offending[:SAMPLE_LIMIT]
    ]
    if len(offending) > SAMPLE_LIMIT:
        remaining = len(offending) - SAMPLE_LIMIT
        failures.append(
            failure(Tier0Check.console, f"{remaining} more console messages failed the check")
        )
    return failures


def text_observation(response: BrowserStepResponse, text: str) -> bool | None:
    observed = response.dom_state
    return observed.text_found.get(text) if observed is not None else None


def dom_failures(response: BrowserStepResponse, expect: DomStateExpect) -> list[Tier0Failure]:
    failures: list[Tier0Failure] = []
    if expect.url is not None and not url_matches(response.url, expect.url):
        failures.append(
            failure(
                Tier0Check.dom_state,
                f"the page is at {response.url}",
                expect.url,
                response.url,
            )
        )
    if expect.title_contains is not None:
        title = response.title
        if title is None or expect.title_contains.lower() not in title.lower():
            failures.append(
                failure(
                    Tier0Check.dom_state,
                    f"the page title does not contain {expect.title_contains!r}",
                    expect.title_contains,
                    title,
                )
            )
    failures.extend(text_failures(response, expect))
    failures.extend(element_failures(response, expect))
    return failures


def text_failures(response: BrowserStepResponse, expect: DomStateExpect) -> list[Tier0Failure]:
    failures: list[Tier0Failure] = []
    for text in expect.text_contains:
        found = text_observation(response, text)
        if found is not True:
            message = (
                f"the page does not show {text!r}"
                if found is False
                else f"whether the page shows {text!r} was not observed"
            )
            failures.append(failure(Tier0Check.dom_state, message, text))
    for text in expect.text_not_contains:
        found = text_observation(response, text)
        if found is not False:
            message = (
                f"the page shows {text!r}, which must not appear"
                if found is True
                else f"whether the page shows {text!r} was not observed"
            )
            failures.append(failure(Tier0Check.dom_state, message, text))
    return failures


def element_failures(response: BrowserStepResponse, expect: DomStateExpect) -> list[Tier0Failure]:
    observed = response.dom_state
    elements = observed.elements if observed is not None else {}
    failures: list[Tier0Failure] = []
    for target in expect.visible:
        state = elements.get(target.key())
        if state != "visible":
            message = f"the element {target.key()} is not visible"
            actual: JsonValue = state if state is not None else "not observed"
            failures.append(failure(Tier0Check.dom_state, message, "visible", actual))
    for target in expect.hidden:
        state = elements.get(target.key())
        if state not in ("hidden", "missing"):
            message = f"the element {target.key()} is not hidden"
            actual = state if state is not None else "not observed"
            failures.append(failure(Tier0Check.dom_state, message, "hidden", actual))
    return failures


def browser_failures(record: StepRecord, expect: BrowserExpect) -> list[Tier0Failure]:
    failures = adapter_failure(record, Tier0Check.dom_state)
    response = record.response
    if not isinstance(response, BrowserStepResponse):
        return failures
    if expect.console is not None:
        failures.extend(console_failures(response, expect.console))
    if expect.dom_state is not None:
        failures.extend(dom_failures(response, expect.dom_state))
    return in_check_order(failures)
