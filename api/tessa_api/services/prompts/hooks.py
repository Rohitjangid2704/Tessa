import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from tessa_api.services.prompt_composer import (
    PromptCompositionError,
    bundle_schema_url,
    render_template,
)
from tessa_api.services.prompts.explain_text import Masker, elide_middle

BUNDLE_VERSION = "BUNDLE_VERSION"
TARGET_TOKEN = "TARGET_TOKEN"
HOOK_COUNT = "HOOK_COUNT"
HOOKS = "HOOKS"
SCHEMA_URL = "SCHEMA_URL"

HOOKS_PROMPT_MAX_CHARS = 20000
MAX_LISTED_HOOKS = 50
DESCRIPTION_LIMITS = (800, 400, 200, 100)
ID_LIMIT = 80
OTHER_HOOK_CONTRACT = (
    "Do what the description says and nothing more; the route takes JSON and answers JSON."
)

HOOK_CONTRACTS: Mapping[str, str] = {
    "pin_clock": (
        "Tessa sends one request before a run: a JSON body with the field `at`, an ISO 8601 "
        "UTC timestamp with milliseconds. After a 2xx answer every date and time the app computes "
        "(today, now, relative ranges, expiry, age) must use that moment, until the next call or "
        "a restart of the process. Require nothing else in the body."
    ),
    "reset": (
        "Restore the QA data to the seeded state the bundle describes, then answer 2xx. Calling it "
        "twice in a row leaves the same data. It must never run against production data."
    ),
    "set_flags": (
        "Take a JSON object that maps feature flag names to true or false, apply the values to the "
        "running app until the process restarts, and answer the flags now in effect."
    ),
    "flush_cache": (
        "Empty the caches that can hold stale answers (query, response and session caches except "
        "logged-in sessions) and answer 2xx."
    ),
    "trace": (
        "Take the id of a request or conversation and answer the tool calls and database reads "
        "that made it, as JSON, without secrets or personal data."
    ),
    "usage": "Answer the model token and cost totals the app has recorded so far, as JSON.",
    "health": "Answer 2xx with a short JSON body when the app and its dependencies are up.",
}


@dataclass(frozen=True, slots=True)
class HookRequest:
    hook_id: str
    description: str


@dataclass(frozen=True, slots=True)
class HooksInputs:
    target_token: str
    bundle_version: int
    hooks: tuple[HookRequest, ...]


@dataclass(frozen=True, slots=True)
class HooksRender:
    text: str
    masked_hits: int
    elided: bool


def one_line(text: str, limit: int) -> str:
    collapsed = " ".join(text.split())
    return collapsed if len(collapsed) <= limit else f"{collapsed[: limit - 3]}..."


def quoted(text: str, limit: int) -> str:
    return json.dumps(one_line(text, limit), ensure_ascii=False)


def masked_hook(request: HookRequest, masker: Masker) -> HookRequest:
    return HookRequest(
        hook_id=masker.text(request.hook_id), description=masker.text(request.description)
    )


def hook_block(position: int, request: HookRequest, description_limit: int) -> str:
    contract = HOOK_CONTRACTS.get(request.hook_id, OTHER_HOOK_CONTRACT)
    description = quoted(request.description, description_limit) if request.description else "none"
    return "\n".join(
        [
            f"### {position}. `{one_line(request.hook_id, ID_LIMIT)}`",
            f"- Why the bundle lists it: {description}",
            f"- What it must do: {contract}",
        ]
    )


def hooks_block(requests: Sequence[HookRequest], description_limit: int) -> str:
    listed = requests[:MAX_LISTED_HOOKS]
    blocks = [
        hook_block(position, request, description_limit)
        for position, request in enumerate(listed, start=1)
    ]
    hidden = len(requests) - len(listed)
    if hidden > 0:
        blocks.append(f"{hidden} more hooks are listed in `test_hooks.missing` of the manifest.")
    return "\n\n".join(blocks)


def clipped(requests: Sequence[HookRequest], limit: int) -> bool:
    return len(requests) > MAX_LISTED_HOOKS or any(
        len(" ".join(request.description.split())) > limit for request in requests
    )


def render_hooks(
    template_text: str,
    public_api_url: str,
    inputs: HooksInputs,
    max_chars: int = HOOKS_PROMPT_MAX_CHARS,
) -> HooksRender:
    masker = Masker()
    requests = [masked_hook(request, masker) for request in inputs.hooks]
    values = {
        BUNDLE_VERSION: str(inputs.bundle_version),
        TARGET_TOKEN: inputs.target_token,
        HOOK_COUNT: str(len(requests)),
        SCHEMA_URL: bundle_schema_url(public_api_url),
    }
    for limit in DESCRIPTION_LIMITS:
        text = render_template(template_text, {**values, HOOKS: hooks_block(requests, limit)})
        if len(text) <= max_chars:
            return HooksRender(
                text=masker.text(text), masked_hits=masker.hits, elided=clipped(requests, limit)
            )
    smallest = render_template(
        template_text, {**values, HOOKS: hooks_block(requests, DESCRIPTION_LIMITS[-1])}
    )
    if len(smallest) - max_chars > len(smallest) // 2:
        raise PromptCompositionError("The Hooks prompt could not be fitted under the size limit")
    return HooksRender(
        text=elide_middle(masker.text(smallest), max_chars), masked_hits=masker.hits, elided=True
    )
