import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.oracles import GoldPoint
from tessa_api.schemas.scenario import ScenarioStep
from tessa_api.schemas.steps import Tier0Failure
from tessa_api.services.gold_interpolation import (
    GOLD_REFERENCE_PATTERN,
    gold_keys_in_text,
    interpolate_gold_text,
    interpolate_gold_value,
    rendered_gold,
    texts_missing_with_digit_boundaries,
)

ANSWER_PREVIEW_CHARS = 200


@dataclass(frozen=True, slots=True)
class InterpolatedStep:
    step: ScenarioStep
    gold_answer_texts: tuple[str, ...]


def gold_mapping(points: Iterable[GoldPoint]) -> dict[str, GoldPoint]:
    return {point.key: point for point in points}


def interpolate_regex(pattern: str, gold: Mapping[str, GoldPoint]) -> str:
    return GOLD_REFERENCE_PATTERN.sub(
        lambda match: re.escape(rendered_gold(gold, match.group(1))), pattern
    )


def split_answer_texts(
    texts: Sequence[str], gold: Mapping[str, GoldPoint]
) -> tuple[list[str], list[str]]:
    plain = [text for text in texts if not gold_keys_in_text(text)]
    from_gold = [interpolate_gold_text(text, gold) for text in texts if gold_keys_in_text(text)]
    return plain, from_gold


def interpolate_sse_expect(expect: dict[str, Any], gold: Mapping[str, GoldPoint]) -> list[str]:
    plain, from_gold = split_answer_texts(expect.get("text_contains", []), gold)
    if "text_contains" in expect:
        expect["text_contains"] = plain
    if "text_contains_any" in expect:
        expect["text_contains_any"] = [
            interpolate_gold_text(text, gold) for text in expect["text_contains_any"]
        ]
    return from_gold


def interpolate_http_expect(expect: dict[str, Any], gold: Mapping[str, GoldPoint]) -> None:
    for field in expect.get("fields", []):
        if "equals" in field:
            field["equals"] = interpolate_gold_value(field["equals"], gold)
        if "matches" in field:
            field["matches"] = interpolate_regex(field["matches"], gold)


def interpolate_message_expect(expect: dict[str, Any], gold: Mapping[str, GoldPoint]) -> None:
    interpolate_http_expect(expect, gold)
    if "text_contains" in expect:
        expect["text_contains"] = [
            interpolate_gold_text(text, gold) for text in expect["text_contains"]
        ]


def interpolate_browser_expect(expect: dict[str, Any], gold: Mapping[str, GoldPoint]) -> None:
    dom_state = expect.get("dom_state")
    if dom_state is not None and "text_contains" in dom_state:
        dom_state["text_contains"] = [
            interpolate_gold_text(text, gold) for text in dom_state["text_contains"]
        ]


def interpolate_step(step: ScenarioStep, gold: Mapping[str, GoldPoint]) -> InterpolatedStep:
    document = step.model_dump(mode="json", by_alias=True, exclude_none=True)
    expect: dict[str, Any] = document.get("expect", {})
    answer_texts: list[str] = []
    if step.adapter == "sse":
        answer_texts = interpolate_sse_expect(expect, gold)
    elif step.adapter in ("http", "graphql"):
        interpolate_http_expect(expect, gold)
    elif step.adapter == "websocket":
        interpolate_message_expect(expect, gold)
    else:
        interpolate_browser_expect(expect, gold)
    return InterpolatedStep(type(step).model_validate(document), tuple(answer_texts))


def gold_text_failures(answer: str | None, gold_answer_texts: Sequence[str]) -> list[Tier0Failure]:
    shown = None if answer is None else answer[:ANSWER_PREVIEW_CHARS]
    return [
        Tier0Failure(
            check=Tier0Check.text_contains,
            message=f"the answer does not contain {text!r} (numbers matched on digit boundaries)",
            expected=text,
            actual=shown,
        )
        for text in texts_missing_with_digit_boundaries(answer, gold_answer_texts)
    ]
