import json
import re
from collections.abc import Iterator, Mapping, Sequence

from pydantic import JsonValue

from tessa_api.schemas.oracles import GoldPoint

GOLD_REFERENCE_PATTERN = re.compile(r"\$\{gold\.([a-z][a-z0-9_]*)\}")
LOOSE_GOLD_REFERENCE_PATTERN = re.compile(r"\$\{gold\.[^}]*\}")
WHOLE_GOLD_REFERENCE_PATTERN = re.compile(r"^\$\{gold\.([a-z][a-z0-9_]*)\}$")
DIGITS = "0123456789"
NUMBER_SEPARATORS = (".", ",")


class UnknownGoldKeyError(KeyError):
    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key

    def __str__(self) -> str:
        return f"no gold point named {self.key!r} is available"


def gold_keys_in_text(text: str) -> list[str]:
    return GOLD_REFERENCE_PATTERN.findall(text)


def malformed_gold_references(text: str) -> list[str]:
    return [
        match.group(0)
        for match in LOOSE_GOLD_REFERENCE_PATTERN.finditer(text)
        if GOLD_REFERENCE_PATTERN.fullmatch(match.group(0)) is None
    ]


def iter_strings(value: JsonValue) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from iter_strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from iter_strings(item)


def gold_keys_in_value(value: JsonValue) -> list[str]:
    return [key for text in iter_strings(value) for key in gold_keys_in_text(text)]


def text_of_value(value: JsonValue) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:.15g}"
    if value is None:
        return ""
    return json.dumps(value, sort_keys=True, separators=(", ", ": "), ensure_ascii=False)


def rendered_gold(gold: Mapping[str, GoldPoint], key: str) -> str:
    point = gold.get(key)
    if point is None:
        raise UnknownGoldKeyError(key)
    return point.rendered


def interpolate_gold_text(text: str, gold: Mapping[str, GoldPoint]) -> str:
    return GOLD_REFERENCE_PATTERN.sub(lambda match: rendered_gold(gold, match.group(1)), text)


def interpolate_gold_value(value: JsonValue, gold: Mapping[str, GoldPoint]) -> JsonValue:
    if isinstance(value, str):
        whole = WHOLE_GOLD_REFERENCE_PATTERN.match(value)
        if whole is not None:
            point = gold.get(whole.group(1))
            if point is None:
                raise UnknownGoldKeyError(whole.group(1))
            return point.value
        return interpolate_gold_text(value, gold)
    if isinstance(value, list):
        return [interpolate_gold_value(item, gold) for item in value]
    if isinstance(value, dict):
        return {key: interpolate_gold_value(item, gold) for key, item in value.items()}
    return value


def is_number_part(text: str, position: int) -> bool:
    return 0 <= position < len(text) and text[position] in DIGITS


def number_precedes(text: str, start: int) -> bool:
    if is_number_part(text, start - 1):
        return True
    return text[start - 1 : start] in NUMBER_SEPARATORS and is_number_part(text, start - 2)


def number_follows(text: str, end: int) -> bool:
    if is_number_part(text, end):
        return True
    return text[end : end + 1] in NUMBER_SEPARATORS and is_number_part(text, end + 1)


def contains_with_digit_boundaries(text: str, needle: str) -> bool:
    if not needle:
        return True
    haystack = text.casefold()
    wanted = needle.casefold()
    starts_with_digit = wanted[0] in DIGITS
    ends_with_digit = wanted[-1] in DIGITS
    position = haystack.find(wanted)
    while position != -1:
        end = position + len(wanted)
        if not (starts_with_digit and number_precedes(haystack, position)) and not (
            ends_with_digit and number_follows(haystack, end)
        ):
            return True
        position = haystack.find(wanted, position + 1)
    return False


def texts_missing_with_digit_boundaries(text: str | None, needles: Sequence[str]) -> list[str]:
    haystack = text or ""
    return [needle for needle in needles if not contains_with_digit_boundaries(haystack, needle)]
