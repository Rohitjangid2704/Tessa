import json
import re
from collections.abc import Mapping
from urllib.parse import quote, quote_plus

from pydantic import JsonValue


def placeholder_for(name: str) -> str:
    return "${" + name + "}"


def secret_variants(value: str) -> set[str]:
    variants = {
        value,
        quote(value, safe=""),
        quote_plus(value),
        json.dumps(value)[1:-1],
        json.dumps(value, ensure_ascii=False)[1:-1],
    }
    return {variant for variant in variants if variant}


class Redactor:
    def __init__(self, secrets: Mapping[str, str] | None = None) -> None:
        self._placeholders: dict[str, str] = {}
        self._pattern: re.Pattern[str] | None = None
        for name, value in (secrets or {}).items():
            self.register(name, value)

    def register(self, name: str, value: str) -> None:
        placeholder = placeholder_for(name)
        for variant in secret_variants(value):
            self._placeholders.setdefault(variant, placeholder)
        self._pattern = None

    @property
    def max_secret_length(self) -> int:
        return max((len(needle) for needle in self._placeholders), default=0)

    def contains_secret(self, text: str) -> bool:
        pattern = self._compiled()
        return pattern is not None and pattern.search(text) is not None

    def redact_text(self, text: str) -> str:
        pattern = self._compiled()
        if pattern is None:
            return text
        return pattern.sub(lambda match: self._placeholders[match.group(0)], text)

    def redact_prefix(self, text: str) -> str:
        redacted = self.redact_text(text)
        fragment_length = self.max_secret_length - 1
        if fragment_length <= 0:
            return redacted
        return redacted[: max(0, len(redacted) - fragment_length)]

    def redact_json(self, value: JsonValue) -> JsonValue:
        if isinstance(value, str):
            return self.redact_text(value)
        if isinstance(value, list):
            return [self.redact_json(item) for item in value]
        if isinstance(value, dict):
            return {self.redact_text(key): self.redact_json(item) for key, item in value.items()}
        return value

    def redact_object(self, value: dict[str, JsonValue]) -> dict[str, JsonValue]:
        redacted = self.redact_json(value)
        return redacted if isinstance(redacted, dict) else {}

    def redact_mapping(self, values: Mapping[str, str]) -> dict[str, str]:
        return {self.redact_text(key): self.redact_text(value) for key, value in values.items()}

    def _compiled(self) -> re.Pattern[str] | None:
        if not self._placeholders:
            return None
        if self._pattern is None:
            needles = sorted(self._placeholders, key=len, reverse=True)
            self._pattern = re.compile("|".join(re.escape(needle) for needle in needles))
        return self._pattern
