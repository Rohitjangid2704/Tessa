import json
import re
from collections.abc import Iterable
from urllib.parse import urlsplit

from tessa_api.schemas.steps import (
    BrowserStepResponse,
    HttpStepRequest,
    HttpStepResponse,
    SseStepRequest,
    SseStepResponse,
)
from tessa_worker.invariants.base import clipped
from tessa_worker.invariants.contracts import InvariantStep

SCAN_LIMIT = 200_000
KEY_SCAN_DEPTH = 12
KEY_SCAN_LIMIT = 5_000
LABEL_LIMIT = 80
UUID_SEGMENT = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
HEX_SEGMENT = re.compile(r"[0-9a-fA-F]{16,}")
NUMBER_SEGMENT = re.compile(r"\d+")


def path_template(path: str) -> str:
    segments = []
    for segment in path.split("/"):
        if UUID_SEGMENT.fullmatch(segment) or HEX_SEGMENT.fullmatch(segment):
            segments.append("{id}")
        elif NUMBER_SEGMENT.fullmatch(segment):
            segments.append("{n}")
        else:
            segments.append(segment)
    return "/".join(segments)


def headline(step: InvariantStep) -> str:
    request = step.request
    if isinstance(request, HttpStepRequest | SseStepRequest):
        path = urlsplit(request.url).path or "/"
        return f"{request.method.upper()} {path_template(path)}"
    return clipped(step.label, LABEL_LIMIT)


def response_status(step: InvariantStep) -> int | None:
    response = step.response
    if isinstance(response, HttpStepResponse | SseStepResponse):
        return response.status
    return None


def browser_response(step: InvariantStep) -> BrowserStepResponse | None:
    return step.response if isinstance(step.response, BrowserStepResponse) else None


def answer_of(step: InvariantStep) -> str | None:
    answer = (step.answer or "").strip()
    return answer or None


def ask_of(step: InvariantStep) -> str | None:
    ask = (step.ask or "").strip()
    return ask or None


def json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, default=str, sort_keys=True)


def response_texts(step: InvariantStep) -> list[str]:
    texts: list[str] = []
    response = step.response
    if isinstance(response, HttpStepResponse):
        if response.body is not None:
            texts.append(json_text(response.body))
        if response.body_text:
            texts.append(response.body_text)
    elif isinstance(response, SseStepResponse):
        texts.extend(event.data for event in response.events if event.data)
    elif isinstance(response, BrowserStepResponse):
        texts.extend(item for item in (response.title, response.text_excerpt) if item)
    if step.answer:
        texts.append(step.answer)
    if step.cards:
        texts.append(json_text(step.cards))
    return bounded(texts)


def bounded(texts: Iterable[str]) -> list[str]:
    kept: list[str] = []
    remaining = SCAN_LIMIT
    for text in texts:
        if remaining <= 0:
            break
        kept.append(text[:remaining])
        remaining -= len(text)
    return kept


def collect_keys(value: object, keys: set[str], depth: int = 0) -> None:
    if depth > KEY_SCAN_DEPTH or len(keys) >= KEY_SCAN_LIMIT:
        return
    if isinstance(value, dict):
        for key, item in value.items():
            keys.add(str(key).casefold())
            collect_keys(item, keys, depth + 1)
    elif isinstance(value, list):
        for item in value:
            collect_keys(item, keys, depth + 1)


def parsed_json(text: str) -> object | None:
    stripped = text.strip()
    if not stripped or stripped[0] not in "{[":
        return None
    try:
        parsed: object = json.loads(stripped)
    except ValueError:
        return None
    return parsed


def json_key_names(step: InvariantStep) -> set[str]:
    keys: set[str] = set()
    response = step.response
    if isinstance(response, HttpStepResponse):
        collect_keys(response.body, keys)
        if response.body_text:
            collect_keys(parsed_json(response.body_text), keys)
    elif isinstance(response, SseStepResponse):
        for event in response.events:
            collect_keys(parsed_json(event.data), keys)
    for card in step.cards:
        collect_keys(card, keys)
    return keys


def idempotency_key_of(step: InvariantStep) -> str | None:
    request = step.request
    if not isinstance(request, HttpStepRequest | SseStepRequest):
        return None
    for name, value in request.headers.items():
        if "idempotency" in name.casefold():
            return value
    return None
