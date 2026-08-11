import pytest

from tessa_api.schemas.bundle import BUNDLE_SCHEMA_VERSION
from tessa_api.schemas.enums import AppKind
from tessa_api.services.app_kinds import default_hint_ids, hint_instructions, known_hint_ids
from tessa_api.services.fixup_items import (
    NOTHING_TO_FIX_TEXT,
    build_fixup_items,
    render_fixup_items,
)
from tessa_api.services.prompt_composer import (
    NO_HINTS_TEXT,
    PromptCompositionError,
    bundle_schema_url,
    render_discovery,
    render_fixup,
    render_hints,
    render_template,
    template_variables,
)
from tests.test_prompt_templates import SHIPPED_FILES, shipped_text

PUBLIC_API_URL = "http://localhost:8000"
TARGET_TOKEN = "tgt_abcdefghijklmnopqrstuv"
SCHEMA_URL = "http://localhost:8000/schemas/bundle.v1.json"


def test_every_placeholder_is_substituted() -> None:
    assert render_template("{{A_B}} and {{C1}} and {{A_B}}", {"A_B": "x", "C1": "y"}) == (
        "x and y and x"
    )


def test_an_unresolved_placeholder_raises_and_names_it() -> None:
    with pytest.raises(PromptCompositionError, match="Unresolved placeholders: SECOND"):
        render_template("{{FIRST}} {{SECOND}}", {"FIRST": "x"})


def test_a_value_the_template_does_not_use_raises() -> None:
    with pytest.raises(PromptCompositionError, match="does not use: EXTRA"):
        render_template("{{FIRST}}", {"FIRST": "x", "EXTRA": "y"})


@pytest.mark.parametrize(
    "text",
    [
        "{{ FIRST }}",
        "{{first}}",
        "{{First}}",
        "{{1ST}}",
        "{{FIRST",
        "{{{FIRST}}}",
        "{{ rows | length }}",
        "{{}}",
        "{{FIRST-NAME}}",
    ],
)
def test_malformed_double_brace_text_raises_instead_of_slipping_through(text: str) -> None:
    with pytest.raises(PromptCompositionError, match="Malformed or unknown placeholder"):
        render_template(text, {"FIRST": "x"})


def test_escaped_braces_render_as_literal_braces() -> None:
    rendered = render_template("{{{{ rows | length }}}} for {{NAME}}", {"NAME": "x"})
    assert rendered == "{{ rows | length }} for x"


def test_a_single_closing_pair_in_yaml_flow_text_is_left_alone() -> None:
    assert render_template("a: {b: {c: 1}} {{NAME}}", {"NAME": "x"}) == "a: {b: {c: 1}} x"


def test_values_are_inserted_verbatim_and_never_scanned_again() -> None:
    values = {"FIRST": "{{SECOND}}", "SECOND": "{{{{"}
    assert render_template("{{FIRST}}|{{SECOND}}", values) == "{{SECOND}}|{{{{"


def test_template_variables_are_unique_and_in_order_of_first_use() -> None:
    assert template_variables("{{B}} {{A}} {{B}} {{{{ not }}}}") == ["B", "A"]


def test_the_schema_url_is_the_published_bundle_schema_of_the_public_api() -> None:
    assert bundle_schema_url(PUBLIC_API_URL) == SCHEMA_URL
    assert BUNDLE_SCHEMA_VERSION == 1


def test_hints_render_as_a_bullet_list_in_registry_order() -> None:
    hint_ids = known_hint_ids(AppKind.llm_assistant)
    rendered = render_hints(AppKind.llm_assistant, list(reversed(hint_ids)))
    expected = hint_instructions(AppKind.llm_assistant, hint_ids)
    assert rendered.splitlines() == [f"- {instruction}" for instruction in expected]


def test_no_hints_render_a_visible_sentence() -> None:
    assert render_hints(AppKind.api, []) == NO_HINTS_TEXT


def test_the_discovery_prompt_carries_the_token_the_schema_url_and_the_selected_hints() -> None:
    hint_ids = default_hint_ids(AppKind.llm_assistant)
    rendered = render_discovery(
        shipped_text("discovery"), PUBLIC_API_URL, TARGET_TOKEN, AppKind.llm_assistant, hint_ids
    )
    assert f"target_token {TARGET_TOKEN}" in rendered
    assert f"schema {SCHEMA_URL}" in rendered
    assert rendered.count(SCHEMA_URL) == 2
    for instruction in hint_instructions(AppKind.llm_assistant, hint_ids):
        assert f"- {instruction}" in rendered
    assert "{{{{" not in rendered
    assert "{{SCHEMA_URL}}" not in rendered
    assert "{{ rows | length }} rooms have open maintenance issues." in rendered


def test_the_discovery_prompt_keeps_the_plan_text_and_adds_the_conventions() -> None:
    rendered = render_discovery(
        shipped_text("discovery"), PUBLIC_API_URL, TARGET_TOKEN, AppKind.web, []
    )
    for sentence in (
        "You are preparing this repository for end-to-end testing by Tessa",
        "Never write a real secret: placeholders only.",
        "Create the folder `tessa/` at the repo root with:",
        "7. openapi.json (or a link) when the app exposes a schema.",
        "## Format conventions",
        "oracle/",
        "flows/",
        "env.template is plain text with one `NAME=value` line per variable",
        "seeds.hash_command",
        "Do not modify application code.",
    ):
        assert sentence in rendered


def test_the_rendered_discovery_prompt_is_deterministic() -> None:
    hint_ids = known_hint_ids(AppKind.api)[:1]
    first = render_discovery(
        shipped_text("discovery"), PUBLIC_API_URL, TARGET_TOKEN, AppKind.api, hint_ids
    )
    second = render_discovery(
        shipped_text("discovery"), PUBLIC_API_URL, TARGET_TOKEN, AppKind.api, hint_ids
    )
    assert first == second


@pytest.mark.parametrize("name", sorted(SHIPPED_FILES))
def test_every_shipped_template_renders_with_the_values_it_declares(name: str) -> None:
    text = shipped_text(name)
    assert "\r" not in text
    assert text.endswith("\n")
    if name == "discovery":
        rendered = render_discovery(text, PUBLIC_API_URL, TARGET_TOKEN, AppKind.cli, [])
    elif name == "fixup":
        rendered = render_fixup(text, PUBLIC_API_URL, TARGET_TOKEN, 3, 62, 80, "1. [error] x")
    else:
        values = {variable: f"<{variable.lower()}>" for variable in template_variables(text)}
        values["TARGET_TOKEN"] = TARGET_TOKEN
        rendered = render_template(text, values)
        for variable, value in values.items():
            assert value in rendered, variable
    assert rendered.count("{{") == text.count("{{{{")
    assert TARGET_TOKEN in rendered


def test_the_fixup_prompt_states_version_score_bar_and_items() -> None:
    items_text = render_fixup_items(
        build_fixup_items(
            [],
            [],
            {
                "score": 62,
                "bar": 80,
                "status": "below_bar",
                "checks": [
                    {
                        "id": "feature_examples",
                        "label": "Every feature has an example",
                        "passed": False,
                        "weight": 20,
                        "earned": 8,
                        "detail": "3 features have no example",
                        "fix_hint": "Add at least one example to each feature",
                    }
                ],
            },
        )
    )
    rendered = render_fixup(
        shipped_text("fixup"), PUBLIC_API_URL, TARGET_TOKEN, 3, 62, 80, items_text
    )
    assert "validated version 3 of the bundle" in rendered
    assert "scored its completeness 62 out of 100; the bar is\n80." in rendered
    assert f"schema {SCHEMA_URL}" in rendered
    assert f"target_token\n{TARGET_TOKEN}" in rendered
    assert "feature_examples" in rendered
    assert "To fix: Add at least one example to each feature" in rendered
    assert "## Format conventions" in rendered
    assert "compares it with version 3" in rendered


def completeness(checks: list[dict[str, object]], score: int = 70) -> dict[str, object]:
    return {"score": score, "bar": 80, "status": "below_bar", "checks": checks}


def check(identifier: str, weight: int, earned: int, **extra: object) -> dict[str, object]:
    return {
        "id": identifier,
        "label": identifier.replace("_", " "),
        "passed": earned == weight,
        "weight": weight,
        "earned": earned,
        **extra,
    }


def test_fixup_items_list_errors_then_missing_points_by_size_then_warnings() -> None:
    items = build_fixup_items(
        [
            {
                "code": "missing",
                "message": "Field required",
                "severity": "error",
                "file": "manifest.yaml",
                "pointer": "/features/2/area",
                "line": 41,
                "column": 5,
            }
        ],
        [
            {
                "code": "file_ignored",
                "message": "Binary file dropped",
                "severity": "warning",
                "file": "seeds/dump.bin",
            }
        ],
        completeness(
            [
                check("required_sections", 20, 20),
                check("oracle_read_only", 15, 10, fix_hint="Make the query read-only"),
                check("feature_examples", 20, 5, detail="4 features lack examples"),
                check("env_template_coverage", 15, 14),
            ]
        ),
    )
    assert [item.kind for item in items] == ["error", "check", "check", "check", "warning"]
    assert items[0].location == "manifest.yaml, /features/2/area, line 41"
    assert items[0].message == "missing: Field required"
    assert [item.location for item in items[1:4]] == [
        "completeness check feature_examples",
        "completeness check oracle_read_only",
        "completeness check env_template_coverage",
    ]
    assert items[1].message == "feature examples: 5 of 20 points. 4 features lack examples"
    assert items[2].fix_hint == "Make the query read-only"
    assert items[4].location == "seeds/dump.bin"


def test_a_bundle_with_nothing_open_renders_one_clear_sentence() -> None:
    items = build_fixup_items([], [], completeness([check("required_sections", 20, 20)], 100))
    assert items == []
    assert render_fixup_items(items) == NOTHING_TO_FIX_TEXT


def test_rendered_items_are_numbered_and_hints_are_indented() -> None:
    items = build_fixup_items(
        [],
        [],
        completeness([check("a_check", 10, 0, fix_hint="Do it"), check("b_check", 10, 5)], score=5),
    )
    assert render_fixup_items(items) == (
        "1. [check] completeness check a_check: a check: 0 of 10 points\n"
        "   To fix: Do it\n"
        "2. [check] completeness check b_check: b check: 5 of 10 points"
    )
