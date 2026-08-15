import re
from collections.abc import Iterable
from urllib.parse import urljoin, urlsplit

from tessa_api.schemas.explore_actions import (
    ClickAction,
    ElementRef,
    ExploreAction,
    FinishAction,
    NavigateAction,
    ReadAction,
    TypeAction,
)
from tessa_worker.adapters.browser_session.snapshot import (
    ADDRESSABLE_ROLES,
    TEXT_ENTRY_ROLES,
    has_element,
)
from tessa_worker.adapters.browser_steps import origin_of
from tessa_worker.lab.contracts import GuardVerdict, PageSnapshot

ALLOWED_SCHEMES = frozenset({"http", "https"})
PLACEHOLDER_MARKER = "${"
READ_ONLY_CLICK_ROLES = frozenset({"link"})
SENSITIVE_NAME_PATTERN = re.compile(
    r"\b(pass(?:word|phrase|code)?|pin|secret|cvv|cvc|otp|card number|security code|"
    r"credit card|social security)\b",
    re.IGNORECASE,
)
SESSION_ENDING_PATTERN = re.compile(r"\b(sign|log)[ -]?out\b", re.IGNORECASE)
ALLOWED = GuardVerdict(allowed=True, reason=None)


def denied(reason: str) -> GuardVerdict:
    return GuardVerdict(allowed=False, reason=reason)


def origins_of(urls: Iterable[str]) -> frozenset[str]:
    return frozenset(origin_of(url) for url in urls if urlsplit(url).netloc)


class ExplorerGuard:
    def __init__(self, allowed_origins: frozenset[str], read_only: bool) -> None:
        self.allowed_origins = allowed_origins
        self.read_only = read_only

    def check(self, action: ExploreAction, snapshot: PageSnapshot) -> GuardVerdict:
        if isinstance(action, NavigateAction):
            return self.check_navigation(action, snapshot)
        if isinstance(action, ClickAction):
            return self.check_click(action, snapshot)
        if isinstance(action, TypeAction):
            return self.check_typing(action, snapshot)
        if isinstance(action, ReadAction):
            return self.check_read(action, snapshot)
        if isinstance(action, FinishAction):
            return ALLOWED
        return denied("the action kind is not known")

    def check_navigation(self, action: NavigateAction, snapshot: PageSnapshot) -> GuardVerdict:
        if PLACEHOLDER_MARKER in action.url:
            return denied("an address may not carry a ${NAME} placeholder")
        address = urljoin(snapshot.url, action.url.strip())
        parts = urlsplit(address)
        if parts.scheme.lower() not in ALLOWED_SCHEMES or not parts.netloc:
            return denied("only http and https addresses on the target are allowed")
        if parts.username is not None or parts.password is not None:
            return denied("an address may not carry credentials")
        if origin_of(address) not in self.allowed_origins:
            return denied("the address is outside the origins of the target's interfaces")
        return ALLOWED

    def check_click(self, action: ClickAction, snapshot: PageSnapshot) -> GuardVerdict:
        missing = self.missing_element(action.target, snapshot)
        if missing is not None:
            return missing
        if action.target.role not in ADDRESSABLE_ROLES:
            return denied(f"{action.target.role} elements cannot be clicked")
        if self.read_only and action.target.role not in READ_ONLY_CLICK_ROLES:
            return denied("this run is read only: only links may be clicked")
        if SESSION_ENDING_PATTERN.search(action.target.name):
            return denied("the exploration keeps its session: signing out is not allowed")
        return ALLOWED

    def check_typing(self, action: TypeAction, snapshot: PageSnapshot) -> GuardVerdict:
        if self.read_only:
            return denied("this run is read only: nothing may be typed")
        missing = self.missing_element(action.target, snapshot)
        if missing is not None:
            return missing
        if action.target.role not in TEXT_ENTRY_ROLES:
            return denied(f"text cannot be typed into a {action.target.role}")
        if SENSITIVE_NAME_PATTERN.search(action.target.name):
            return denied("password and other credential fields are never filled")
        if PLACEHOLDER_MARKER in action.text:
            return denied("typed text may not carry a ${NAME} placeholder")
        return ALLOWED

    def check_read(self, action: ReadAction, snapshot: PageSnapshot) -> GuardVerdict:
        if action.target is None:
            return ALLOWED
        return self.missing_element(action.target, snapshot) or ALLOWED

    def missing_element(self, target: ElementRef, snapshot: PageSnapshot) -> GuardVerdict | None:
        if has_element(snapshot.text, target):
            return None
        return denied(
            f'the page snapshot has no {target.role} named "{target.name}" with index '
            f"{target.index}"
        )
