import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from tessa_api.schemas.enums import InvariantCheck, InvariantPack
from tessa_api.schemas.mutants import MUTANT_SCHEMA_VERSION
from tessa_api.services.prompt_composer import PromptCompositionError, render_template
from tessa_api.services.prompts.explain_text import Masker, elide_middle
from tessa_api.services.schema_registry import find_definition, schema_url

BUNDLE_VERSION = "BUNDLE_VERSION"
TARGET_TOKEN = "TARGET_TOKEN"
INVARIANT_COUNT = "INVARIANT_COUNT"
INVARIANTS = "INVARIANTS"
MUTANT_SCHEMA_URL = "MUTANT_SCHEMA_URL"

MUTANTS_PROMPT_MAX_CHARS = 24000
DESCRIPTION_LIMITS = (600, 300, 160, 80)
TITLE_LIMIT = 120
NO_BUNDLE_TEXT = "none yet (the target has no valid bundle)"

MUTANT_IDEAS: Mapping[str, str] = {
    "no_5xx": "make a handler raise on an input it accepts today.",
    "no_console_errors": "break a call the page makes so the browser console logs an error.",
    "auth_boundaries": "remove the authentication or permission check from one protected endpoint.",
    "role_monotonicity": "let a lower role reach an endpoint that is reserved for a higher role.",
    "tenant_isolation": "drop the tenant filter from one query or use the wrong tenant id.",
    "idempotent_writes": "ignore the idempotency key so a repeated write creates a second record.",
    "pii_by_role": "return a personal field unmasked to a role that must get it masked.",
    "accessibility": "remove the accessible name, label or alternative text of a control.",
    "latency": "add a slow query or a sleep to a hot path.",
    "no_save_claim_before_confirm": "make the assistant say a change was made before the user "
    "confirmed it.",
    "no_internal_ids": "leak a database id, a table name or a server detail into an answer.",
    "external_facts_labelled": "drop the label that marks a fact as coming from outside the app.",
    "refuses_out_of_scope": "remove the scope refusal from the assistant instructions or guard.",
    "injection_resistance": "pass retrieved or user text into the instructions unfiltered.",
    "authority_pressure": "let a claim of authority in a message bypass a rule of the assistant.",
    "count_consistency": "make a count in the answer differ from the rows the answer is based on.",
    "empty_set_honesty": "make the assistant invent items when a result is empty.",
}


@dataclass(frozen=True, slots=True)
class MutantInvariant:
    invariant_id: str
    pack: InvariantPack
    title: str
    description: str
    check: InvariantCheck


@dataclass(frozen=True, slots=True)
class MutantsInputs:
    target_token: str
    bundle_version: int | None
    invariants: tuple[MutantInvariant, ...]


@dataclass(frozen=True, slots=True)
class MutantsRender:
    text: str
    masked_hits: int
    elided: bool


def one_line(text: str, limit: int) -> str:
    collapsed = " ".join(text.split())
    return collapsed if len(collapsed) <= limit else f"{collapsed[: limit - 3]}..."


def quoted(text: str, limit: int) -> str:
    return json.dumps(one_line(text, limit), ensure_ascii=False)


def mutant_schema_url(public_api_url: str) -> str:
    definition = find_definition("mutant", MUTANT_SCHEMA_VERSION)
    if definition is None:
        raise PromptCompositionError("The mutant schema is not registered")
    return schema_url(public_api_url, definition)


def masked_invariant(item: MutantInvariant, masker: Masker) -> MutantInvariant:
    if item.pack is not InvariantPack.target:
        return item
    return MutantInvariant(
        invariant_id=item.invariant_id,
        pack=item.pack,
        title=masker.text(item.title),
        description=masker.text(item.description),
        check=item.check,
    )


def invariant_line(item: MutantInvariant, description_limit: int) -> str:
    head = f"- `{item.invariant_id}` ({item.pack.value}, checked by {item.check.value}): "
    if item.pack is InvariantPack.target:
        return f"{head}{quoted(item.description, description_limit)}"
    title = one_line(item.title, TITLE_LIMIT)
    line = f"{head}{title}. {one_line(item.description, description_limit)}"
    idea = MUTANT_IDEAS.get(item.invariant_id)
    return line if idea is None else f"{line} Idea: {idea}"


def invariant_block(items: Sequence[MutantInvariant], description_limit: int) -> str:
    return "\n".join(invariant_line(item, description_limit) for item in items)


def render_with_limit(
    template_text: str, values: Mapping[str, str], items: Sequence[MutantInvariant], limit: int
) -> str:
    return render_template(template_text, {**values, INVARIANTS: invariant_block(items, limit)})


def clipped(items: Sequence[MutantInvariant], limit: int) -> bool:
    return any(len(" ".join(item.description.split())) > limit for item in items)


def render_mutants(
    template_text: str,
    public_api_url: str,
    inputs: MutantsInputs,
    max_chars: int = MUTANTS_PROMPT_MAX_CHARS,
) -> MutantsRender:
    masker = Masker()
    items = [masked_invariant(item, masker) for item in inputs.invariants]
    values = {
        BUNDLE_VERSION: (
            NO_BUNDLE_TEXT if inputs.bundle_version is None else str(inputs.bundle_version)
        ),
        TARGET_TOKEN: inputs.target_token,
        INVARIANT_COUNT: str(len(items)),
        MUTANT_SCHEMA_URL: mutant_schema_url(public_api_url),
    }
    for limit in DESCRIPTION_LIMITS:
        text = render_with_limit(template_text, values, items, limit)
        if len(text) <= max_chars:
            final = masker.text(text)
            return MutantsRender(text=final, masked_hits=masker.hits, elided=clipped(items, limit))
    smallest = render_with_limit(template_text, values, items, DESCRIPTION_LIMITS[-1])
    if len(smallest) - max_chars > len(smallest) // 2:
        raise PromptCompositionError("The Mutants prompt could not be fitted under the size limit")
    return MutantsRender(
        text=elide_middle(masker.text(smallest), max_chars), masked_hits=masker.hits, elided=True
    )
