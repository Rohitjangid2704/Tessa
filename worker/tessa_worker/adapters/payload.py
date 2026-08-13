import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from pydantic import JsonValue


@dataclass(frozen=True)
class FittedJson:
    value: JsonValue
    text: str | None
    truncated: bool


def json_text(value: JsonValue) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def json_size(value: JsonValue) -> int:
    return len(json_text(value).encode("utf-8"))


def fit_text(text: str, limit_bytes: int) -> tuple[str, bool]:
    encoded = text.encode("utf-8")
    if len(encoded) <= limit_bytes:
        return text, False
    return encoded[:limit_bytes].decode("utf-8", errors="ignore"), True


def fit_json(value: JsonValue, limit_bytes: int) -> FittedJson:
    text = json_text(value)
    cut, truncated = fit_text(text, limit_bytes)
    if truncated:
        return FittedJson(value=None, text=cut, truncated=True)
    return FittedJson(value=value, text=None, truncated=False)


def fit_items[Item](
    items: Sequence[Item], size_of: Callable[[Item], int], limit_bytes: int
) -> tuple[list[Item], bool]:
    kept: list[Item] = []
    used = 0
    for item in items:
        used += size_of(item)
        if used > limit_bytes:
            return kept, True
        kept.append(item)
    return kept, False
