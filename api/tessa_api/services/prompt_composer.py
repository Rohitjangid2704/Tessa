import re
from collections.abc import Mapping, Sequence

from tessa_api.schemas.bundle import BUNDLE_SCHEMA_VERSION
from tessa_api.schemas.enums import AppKind
from tessa_api.services.app_kinds import hint_instructions
from tessa_api.services.schema_registry import find_definition, schema_url

OPEN_ESCAPE = "{{{{"
CLOSE_ESCAPE = "}}}}"
TOKEN_PATTERN = re.compile(r"\{\{\{\{|\}\}\}\}|\{\{([A-Z][A-Z0-9_]*)\}\}|\{\{")
SNIPPET_LENGTH = 40

SCHEMA_URL = "SCHEMA_URL"
TARGET_TOKEN = "TARGET_TOKEN"
APP_KIND_HINTS = "APP_KIND_HINTS"
BUNDLE_VERSION = "BUNDLE_VERSION"
COMPLETENESS_SCORE = "COMPLETENESS_SCORE"
COMPLETENESS_BAR = "COMPLETENESS_BAR"
FIXUP_ITEMS = "FIXUP_ITEMS"

NO_HINTS_TEXT = "- No app-specific instructions were selected."


class PromptCompositionError(Exception):
    pass


def malformed_placeholder(text: str, position: int) -> PromptCompositionError:
    snippet = text[position : position + SNIPPET_LENGTH].splitlines()[0]
    return PromptCompositionError(
        f"Malformed or unknown placeholder at {snippet!r}: write a name in capitals between "
        "double braces with no spaces, or escape literal braces as {{{{ and }}}}"
    )


def template_variables(text: str) -> list[str]:
    names: list[str] = []
    for match in TOKEN_PATTERN.finditer(text):
        if match.group(0) == "{{":
            raise malformed_placeholder(text, match.start())
        if match.group(1) is not None:
            names.append(match.group(1))
    return list(dict.fromkeys(names))


def replace_token(match: re.Match[str], values: Mapping[str, str]) -> str:
    token = match.group(0)
    if token == OPEN_ESCAPE:
        return "{{"
    if token == CLOSE_ESCAPE:
        return "}}"
    return values[match.group(1)]


def render_template(text: str, values: Mapping[str, str]) -> str:
    variables = template_variables(text)
    unresolved = [name for name in variables if name not in values]
    if unresolved:
        raise PromptCompositionError(f"Unresolved placeholders: {', '.join(unresolved)}")
    unknown = sorted(set(values) - set(variables))
    if unknown:
        raise PromptCompositionError(f"Variables the template does not use: {', '.join(unknown)}")
    return TOKEN_PATTERN.sub(lambda match: replace_token(match, values), text)


def bundle_schema_url(public_api_url: str) -> str:
    definition = find_definition("bundle", BUNDLE_SCHEMA_VERSION)
    if definition is None:
        raise PromptCompositionError("The bundle schema is not registered")
    return schema_url(public_api_url, definition)


def render_hints(app_kind: AppKind, hint_ids: Sequence[str]) -> str:
    instructions = hint_instructions(app_kind, hint_ids)
    if not instructions:
        return NO_HINTS_TEXT
    return "\n".join(f"- {instruction}" for instruction in instructions)


def render_discovery(
    template_text: str,
    public_api_url: str,
    target_token: str,
    app_kind: AppKind,
    hint_ids: Sequence[str],
) -> str:
    return render_template(
        template_text,
        {
            SCHEMA_URL: bundle_schema_url(public_api_url),
            TARGET_TOKEN: target_token,
            APP_KIND_HINTS: render_hints(app_kind, hint_ids),
        },
    )


def render_fixup(
    template_text: str,
    public_api_url: str,
    target_token: str,
    bundle_version: int,
    completeness_score: int,
    completeness_bar: int,
    items_text: str,
) -> str:
    return render_template(
        template_text,
        {
            SCHEMA_URL: bundle_schema_url(public_api_url),
            TARGET_TOKEN: target_token,
            BUNDLE_VERSION: str(bundle_version),
            COMPLETENESS_SCORE: str(completeness_score),
            COMPLETENESS_BAR: str(completeness_bar),
            FIXUP_ITEMS: items_text,
        },
    )
