import re
from urllib.parse import urlsplit

from tessa_api.schemas.scenario import BrowserStep, BrowserTarget
from tessa_api.schemas.steps import BrowserRequestAction, ConsoleMessage

ABSOLUTE_PREFIXES = ("http://", "https://")
ROLE_PATTERN = re.compile(r"^[a-z]+$")
WHITESPACE_PATTERN = re.compile(r"\s+")
PLAYWRIGHT_CONSOLE_LEVELS = {"warning": "warning", "error": "error", "assert": "error"}

REQUEST_ACTIONS: dict[str, BrowserRequestAction] = {
    "goto": "navigate",
    "click": "click",
    "check": "click",
    "hover": "click",
    "fill": "type",
    "select": "type",
    "press": "press",
    "wait_for": "wait",
}


class StepFailure(Exception):
    pass


def request_action(step: BrowserStep) -> BrowserRequestAction:
    return REQUEST_ACTIONS[step.action]


def step_label(step: BrowserStep) -> str:
    if step.label:
        return step.label
    if step.action == "goto":
        return f"goto {step.url}"
    if step.action == "press" and step.target is None:
        return f"press {step.value}"
    if step.target is not None:
        return f"{step.action} {step.target.key()}"
    return step.action


def navigation_url(base_url: str, url: str) -> str:
    if url.lower().startswith(ABSOLUTE_PREFIXES):
        return url
    return base_url.rstrip("/") + "/" + url.lstrip("/")


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def same_origin(first: str, second: str) -> bool:
    return origin_of(first) == origin_of(second)


def quoted(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def role_of(target: BrowserTarget) -> str:
    role = target.role or ""
    if not ROLE_PATTERN.fullmatch(role):
        raise StepFailure(f"{role!r} is not an accessibility role")
    return role


def hidden_option(include_hidden: bool) -> str:
    return "[include-hidden]" if include_hidden else ""


def exact_selector(target: BrowserTarget, include_hidden: bool = False) -> str:
    if target.selector is not None:
        return target.selector
    name = normalise_whitespace(target.name or "")
    return f"role={role_of(target)}[name={quoted(name)}]{hidden_option(include_hidden)}"


def partial_selector(target: BrowserTarget, include_hidden: bool = False) -> str | None:
    if target.selector is not None:
        return None
    name = normalise_whitespace(target.name or "")
    pattern = re.escape(name).replace("/", r"\/")
    return f"role={role_of(target)}[name=/{pattern}/i]{hidden_option(include_hidden)}"


def console_level(playwright_type: str) -> str:
    return PLAYWRIGHT_CONSOLE_LEVELS.get(playwright_type, playwright_type)


def console_message(playwright_type: str, text: str) -> ConsoleMessage:
    return ConsoleMessage(level=console_level(playwright_type), text=text)


def normalise_whitespace(text: str) -> str:
    return WHITESPACE_PATTERN.sub(" ", text).strip()


def normalise_text(text: str) -> str:
    return normalise_whitespace(text).lower()


def page_shows(page_text: str, wanted: str) -> bool:
    return normalise_text(wanted) in page_text
