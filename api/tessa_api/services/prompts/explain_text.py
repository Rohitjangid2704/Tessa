import json
import re
from collections.abc import Callable, Mapping, Sequence

from pydantic import JsonValue

from tessa_api.services.grading_rules import redacted_text
from tessa_api.services.secret_scan import scan_text

MIN_FENCE_LENGTH = 3
MIN_BODY_CHARS = 40
MIDDLE_HEAD_SHARE = 0.6
NOT_RECORDED = "(not recorded)"
NO_ROOM = "(omitted: no room left under the size limit)"
BACKTICK_RUN = re.compile(r"`+")


class Masker:
    def __init__(self) -> None:
        self.hits = 0

    def text(self, value: str) -> str:
        found = scan_text("explain", value)
        if not found:
            return value
        self.hits += len(found)
        return redacted_text(value)

    def optional(self, value: str | None) -> str | None:
        return None if value is None else self.text(value)

    def json(self, value: JsonValue) -> JsonValue:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.json(item) for item in value]
        if isinstance(value, dict):
            return {key: self.json(item) for key, item in value.items()}
        return value


def fence_length(text: str) -> int:
    longest = max((len(run) for run in BACKTICK_RUN.findall(text)), default=0)
    return max(MIN_FENCE_LENGTH, longest + 1)


def fence(text: str, language: str = "") -> str:
    marker = "`" * fence_length(text)
    return f"{marker}{language}\n{text}\n{marker}"


def elide_middle(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    marker = f"\n[... {len(text) - limit} characters elided ...]\n"
    room = limit - len(marker)
    if room < MIN_BODY_CHARS:
        return text[: max(limit, 0)]
    head = int(room * MIDDLE_HEAD_SHARE)
    return f"{text[:head]}{marker}{text[len(text) - (room - head) :]}"


def fenced_within(text: str, limit: int, language: str = "") -> str:
    overhead = 2 * fence_length(text) + len(language) + 2
    room = limit - overhead
    if room < MIN_BODY_CHARS:
        return NO_ROOM
    return fence(elide_middle(text, room), language)


def json_text(value: JsonValue) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)


def value_block(value: JsonValue, limit: int) -> str:
    if value is None:
        return NOT_RECORDED
    return fenced_within(json_text(value), limit)


def share_budget(
    naturals: Mapping[str, int], weights: Mapping[str, float], budget: int
) -> dict[str, int]:
    shares = {key: min(natural, int(budget * weights[key])) for key, natural in naturals.items()}
    leftover = budget - sum(shares.values())
    for key in sorted(naturals, key=lambda name: -weights[name]):
        grant = min(leftover, naturals[key] - shares[key])
        shares[key] += grant
        leftover -= grant
    return shares


def joined_within(
    lines: Sequence[str], limit: int, omitted: Callable[[int], str]
) -> tuple[str, int]:
    kept: list[str] = []
    used = 0
    for index, line in enumerate(lines):
        if used + len(line) + 1 > limit:
            dropped = len(lines) - index
            kept.append(omitted(dropped))
            return "\n".join(kept), dropped
        kept.append(line)
        used += len(line) + 1
    return "\n".join(kept), 0
