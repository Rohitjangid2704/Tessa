import json

from pydantic import JsonValue

from tessa_api.schemas.steps import HttpStepResponse
from tessa_worker.adapters.base import StepRecord

REPLY_MAX_CHARS = 4000
ELLIPSIS = "…"
EMPTY_REPLY = "(empty reply)"
REPLY_KEYS = ("reply", "answer", "message", "text", "content", "response", "output")


def clip_reply(text: str) -> str:
    if len(text) <= REPLY_MAX_CHARS:
        return text
    return text[: REPLY_MAX_CHARS - len(ELLIPSIS)] + ELLIPSIS


def text_of_body(body: JsonValue) -> str:
    if isinstance(body, str):
        return body
    if isinstance(body, dict):
        for key in REPLY_KEYS:
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                return value
    if body is None:
        return ""
    return json.dumps(body, ensure_ascii=False)


def reply_text_of(record: StepRecord) -> str:
    if record.answer and record.answer.strip():
        return record.answer
    response = record.response
    if isinstance(response, HttpStepResponse):
        if response.body_text and response.body_text.strip():
            return response.body_text
        return text_of_body(response.body)
    return ""


def displayed_reply(record: StepRecord) -> str:
    text = reply_text_of(record).strip()
    return clip_reply(text) if text else EMPTY_REPLY
