import json
from collections.abc import Mapping

from pydantic import JsonValue

from tessa_api.services.grading_rules import clip_text, redacted_text
from tessa_worker.adapters.payload import fit_json, fit_text
from tessa_worker.adapters.redact import Redactor

SENSITIVE_HEADERS = frozenset(
    {"authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"}
)
HIDDEN_VALUE = "[redacted]"
JSON_MEDIA_MARKERS = ("json",)


def safe_text(text: str, redactor: Redactor) -> str:
    return redactor.redact_text(redacted_text(text))


def safe_message(text: str, redactor: Redactor, limit: int) -> str:
    return clip_text(" ".join(safe_text(text, redactor).split()), limit)


def safe_headers(headers: Mapping[str, str], redactor: Redactor) -> dict[str, str]:
    safe: dict[str, str] = {}
    for name, value in headers.items():
        redacted = safe_text(value, redactor)
        if name.lower() in SENSITIVE_HEADERS and redacted == value:
            redacted = HIDDEN_VALUE
        safe[redactor.redact_text(name)] = redacted
    return safe


def is_json_media(headers: Mapping[str, str]) -> bool:
    content_type = next(
        (value for name, value in headers.items() if name.lower() == "content-type"), ""
    )
    return any(marker in content_type.lower() for marker in JSON_MEDIA_MARKERS)


def decoded_text(content: bytes) -> str:
    return content.decode("utf-8", errors="replace")


def parsed_json(text: str) -> JsonValue | None:
    try:
        value: JsonValue = json.loads(text)
    except ValueError:
        return None
    return value


def safe_json_body(
    content: bytes, headers: Mapping[str, str], redactor: Redactor, limit_bytes: int
) -> tuple[JsonValue, str | None, bool]:
    if not content:
        return None, None, False
    text = safe_text(decoded_text(content), redactor)
    if is_json_media(headers):
        value = parsed_json(text)
        if value is not None:
            fitted = fit_json(value, limit_bytes)
            if not fitted.truncated:
                return fitted.value, None, False
            return None, fitted.text, True
    cut, truncated = fit_text(text, limit_bytes)
    return None, cut, truncated


def safe_request_body(
    content: bytes | None, redactor: Redactor, limit_bytes: int
) -> tuple[JsonValue, bool]:
    if not content:
        return None, False
    text = safe_text(decoded_text(content), redactor)
    value = parsed_json(text)
    if value is not None:
        fitted = fit_json(value, limit_bytes)
        return (fitted.text if fitted.truncated else fitted.value), fitted.truncated
    cut, truncated = fit_text(text, limit_bytes)
    return cut, truncated
