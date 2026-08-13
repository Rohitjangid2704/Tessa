import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import unquote_plus, urlsplit, urlunsplit

from pydantic import JsonValue

from tessa_api.schemas.enums import AdapterKind
from tessa_api.schemas.steps import StepRequestUnion, StepResponseUnion
from tessa_worker.adapters.base import StepRecord
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.payload import FittedJson, fit_json, fit_text

REDACTED_VALUE = "[redacted]"
SPAN_MARKER = "[redacted: a secret spans several messages]"
SENSITIVE_QUERY_NAMES = frozenset(
    {
        "token",
        "access_token",
        "id_token",
        "refresh_token",
        "api_key",
        "apikey",
        "key",
        "auth",
        "authorization",
        "secret",
        "client_secret",
        "password",
        "passwd",
        "sig",
        "signature",
        "jwt",
        "session",
        "sid",
    }
)
SENSITIVE_HEADER_PATTERN = re.compile(
    r"authoriz|cookie|token|secret|signature|api[-_]?key|passw|credential|session", re.IGNORECASE
)


@dataclass(frozen=True)
class CutText:
    text: str
    truncated: bool


class PayloadGuard:
    def __init__(self, context: AdapterContext) -> None:
        self.redactor = context.redactor
        self.cap = context.limits.max_payload_bytes

    def read_budget(self, factor: int = 1) -> int:
        return self.cap * factor + self.redactor.max_secret_length + 1

    def error(self, value: str) -> str:
        return self.redactor.redact_text(value)

    def text(self, value: str) -> CutText:
        text, truncated = fit_text(self.redactor.redact_text(value), self.cap)
        return CutText(text, truncated)

    def json(self, value: JsonValue) -> FittedJson:
        return fit_json(self.redactor.redact_json(value), self.cap)

    def raw_text(self, raw: bytes, cut: bool) -> CutText:
        decoded = raw.decode("utf-8", errors="replace")
        redacted = (
            self.redactor.redact_prefix(decoded) if cut else self.redactor.redact_text(decoded)
        )
        text, fit_cut = fit_text(redacted, self.cap)
        return CutText(text, cut or fit_cut)

    def headers(self, values: Mapping[str, str]) -> dict[str, str]:
        return self.redactor.redact_mapping(values)

    def foreign_headers(self, values: Mapping[str, str]) -> dict[str, str]:
        masked: dict[str, str] = {}
        for name, value in values.items():
            shown = REDACTED_VALUE if SENSITIVE_HEADER_PATTERN.search(name) else value
            masked[self.redactor.redact_text(name)] = self.redactor.redact_text(shown)
        return masked

    def url(self, value: str) -> str:
        try:
            parts = urlsplit(value)
        except ValueError:
            return self.redactor.redact_text(value)
        netloc = parts.netloc.rpartition("@")[2]
        query = mask_query(parts.query)
        return self.redactor.redact_text(urlunsplit(parts._replace(netloc=netloc, query=query)))

    def protect_span(self, texts: Sequence[str]) -> list[str]:
        redacted = [self.redactor.redact_text(text) for text in texts]
        if self.redactor.contains_secret("".join(redacted)):
            return [SPAN_MARKER for _ in redacted]
        return redacted


def mask_query(query: str) -> str:
    if not query:
        return query
    pairs: list[str] = []
    for pair in query.split("&"):
        name, separator, _ = pair.partition("=")
        if separator and unquote_plus(name).lower() in SENSITIVE_QUERY_NAMES:
            pairs.append(f"{name}={REDACTED_VALUE}")
        else:
            pairs.append(pair)
    return "&".join(pairs)


def step_record(
    adapter: AdapterKind,
    guard: PayloadGuard,
    label: str,
    request: StepRequestUnion,
    response: StepResponseUnion | None,
    ok: bool,
    error: str | None,
    truncated: bool,
    latency_ms: int,
    started_at: datetime,
) -> StepRecord:
    return StepRecord(
        adapter=adapter,
        label=guard.error(label),
        request=request,
        response=response,
        response_truncated=truncated,
        ok=ok,
        error=guard.error(error) if error is not None else None,
        latency_ms=latency_ms,
        started_at=started_at,
        finished_at=datetime.now(UTC),
    )
