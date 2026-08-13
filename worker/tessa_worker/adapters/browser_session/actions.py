from urllib.parse import urljoin

from tessa_api.schemas.explore_actions import (
    ClickAction,
    ElementRef,
    ExploreAction,
    FinishAction,
    NavigateAction,
    ReadAction,
    TypeAction,
)
from tessa_api.schemas.scenario import BrowserStep
from tessa_worker.adapters.browser_steps import ROLE_PATTERN, normalise_whitespace, quoted

ENTER_KEY = "Enter"
LABEL_TEXT_CHARS = 80
EXPLORE_ACTION_KEY = "explore_action"


class ActionRejectedError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def checked_role(role: str) -> str:
    if not ROLE_PATTERN.fullmatch(role):
        raise ActionRejectedError(f"{role!r} is not an accessibility role")
    return role


def element_selector(target: ElementRef) -> str:
    name = quoted(normalise_whitespace(target.name))
    return f"role={checked_role(target.role)}[name={name}] >> nth={target.index}"


def describe_element(target: ElementRef) -> str:
    suffix = f" #{target.index}" if target.index else ""
    return f'{target.role} "{normalise_whitespace(target.name)}"{suffix}'


def shortened(text: str) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= LABEL_TEXT_CHARS:
        return collapsed
    return collapsed[: LABEL_TEXT_CHARS - 1] + "…"


def action_label(action: ExploreAction) -> str:
    if isinstance(action, NavigateAction):
        return f"navigate {shortened(action.url)}"
    if isinstance(action, ClickAction):
        return f"click {describe_element(action.target)}"
    if isinstance(action, TypeAction):
        submit = " and submit" if action.submit else ""
        return f"type into {describe_element(action.target)}{submit}"
    if isinstance(action, ReadAction):
        if action.target is None:
            return "read the page"
        return f"read {describe_element(action.target)}"
    return "finish"


def action_target_text(action: ExploreAction) -> str | None:
    if isinstance(action, ClickAction | TypeAction):
        return describe_element(action.target)
    if isinstance(action, ReadAction) and action.target is not None:
        return describe_element(action.target)
    return None


def action_typed_text(action: ExploreAction) -> str | None:
    if isinstance(action, TypeAction):
        return action.text
    if isinstance(action, FinishAction):
        return action.claim
    return None


def action_url(action: ExploreAction) -> str | None:
    return action.url if isinstance(action, NavigateAction) else None


def browser_step(
    label: str,
    action: str,
    url: str | None = None,
    selector: str | None = None,
    value: str | None = None,
) -> BrowserStep:
    document: dict[str, object] = {"adapter": "browser", "label": label, "action": action}
    if url is not None:
        document["url"] = url
    if selector is not None:
        document["target"] = {"selector": selector}
    if value is not None:
        document["value"] = value
    return BrowserStep.model_validate(document)


def browser_steps_for(action: ExploreAction, page_url: str) -> list[BrowserStep]:
    label = action_label(action)
    if isinstance(action, NavigateAction):
        return [browser_step(label, "goto", url=urljoin(page_url, action.url))]
    if isinstance(action, ClickAction):
        return [browser_step(label, "click", selector=element_selector(action.target))]
    if isinstance(action, TypeAction):
        selector = element_selector(action.target)
        steps = [browser_step(label, "fill", selector=selector, value=action.text)]
        if action.submit:
            steps.append(browser_step(label, "press", selector=selector, value=ENTER_KEY))
        return steps
    if isinstance(action, ReadAction):
        return [browser_step(label, "wait_for")]
    raise ActionRejectedError("a finish action does not drive the browser")
