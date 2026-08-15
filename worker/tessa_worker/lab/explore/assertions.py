import re

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.explore_actions import SnapshotAssertion
from tessa_api.services.findings.fingerprint import path_template, request_target
from tessa_worker.lab.contracts import FailedRequest, PageSnapshot

URL_CONTAINS = "url_contains"
REACHED = "reached"
REQUEST_FAILED = "request_failed"
VALUE_SEPARATOR = ":"
CONSOLE_FRAGMENT_CHARS = 120
LOGIN_PATH_PATTERN = re.compile(r"(login|log-in|signin|sign-in|sso|auth)", re.IGNORECASE)
DENIAL_PATTERN = re.compile(
    r"(access denied|permission denied|forbidden|not authori[sz]ed|unauthori[sz]ed|"
    r"not allowed|no permission|insufficient permission|do(?:es)? not have (?:access|permission)|"
    r"don't have (?:access|permission)|you cannot access|restricted area|restricted access|"
    r"access restricted)",
    re.IGNORECASE,
)
WHITESPACE_PATTERN = re.compile(r"\s+")


def normalised(text: str) -> str:
    return WHITESPACE_PATTERN.sub(" ", text).strip().lower()


def page_text(snapshot: PageSnapshot) -> str:
    return f"{snapshot.title}\n{snapshot.text}"


def shows_denial(snapshot: PageSnapshot) -> bool:
    return DENIAL_PATTERN.search(page_text(snapshot)) is not None


def is_login_address(url: str) -> bool:
    return LOGIN_PATH_PATTERN.search(path_template(url)) is not None


def reached_assertion(url: str) -> SnapshotAssertion:
    return SnapshotAssertion(
        check=Tier0Check.dom_state, value=f"{REACHED}{VALUE_SEPARATOR}{path_template(url)}"
    )


def failed_request_target(request: FailedRequest) -> str:
    return request_target(request.method, request.url)


def request_failed_assertion(request: FailedRequest) -> SnapshotAssertion:
    value = f"{REQUEST_FAILED}{VALUE_SEPARATOR}{request.status}{VALUE_SEPARATOR}"
    return SnapshotAssertion(
        check=Tier0Check.dom_state, value=value + failed_request_target(request)
    )


def console_assertion(error: str) -> SnapshotAssertion:
    fragment = normalised(error)[:CONSOLE_FRAGMENT_CHARS]
    return SnapshotAssertion(check=Tier0Check.console, value=fragment)


def dom_state_holds(value: str, snapshot: PageSnapshot) -> bool:
    kind, _, detail = value.partition(VALUE_SEPARATOR)
    if kind == URL_CONTAINS:
        return normalised(detail) in normalised(snapshot.url)
    if kind == REACHED:
        return path_template(snapshot.url) == detail and not shows_denial(snapshot)
    if kind == REQUEST_FAILED:
        status_text, _, target = detail.partition(VALUE_SEPARATOR)
        return any(
            str(request.status) == status_text and failed_request_target(request) == target
            for request in snapshot.failed_requests
        )
    return False


def assertion_holds(assertion: SnapshotAssertion, snapshot: PageSnapshot) -> bool:
    wanted = normalised(assertion.value)
    if assertion.check is Tier0Check.text_contains:
        return wanted in normalised(page_text(snapshot))
    if assertion.check is Tier0Check.text_not_contains:
        return wanted not in normalised(page_text(snapshot))
    if assertion.check is Tier0Check.console:
        return any(wanted in normalised(error) for error in snapshot.new_console_errors)
    if assertion.check is Tier0Check.dom_state:
        return dom_state_holds(assertion.value, snapshot)
    return False
