import codecs
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass

from pydantic import JsonValue

from tessa_api.schemas.steps import StepTool

LINE_BREAK = re.compile(r"\r\n|\r|\n")
JSON_STARTS = ("{", "[", '"')
TEXT_EVENTS = frozenset(
    {"", "message", "token", "delta", "text", "answer", "content", "chunk", "answer_delta"}
)
TEXT_KEYS = ("token", "delta", "text", "content", "answer", "message")
FINAL_ANSWER_KEYS = ("answer", "text", "response", "content")
TOOL_EVENTS = frozenset({"tool_call", "tool", "tool_use", "tool_start", "function_call"})
TOOL_RESULT_EVENTS = frozenset({"tool_result", "tool_output"})
CARD_EVENTS = frozenset({"card", "cards", "ui_card", "component"})
DONE_EVENTS = frozenset({"done", "end", "complete", "completed", "final"})
STREAM_END_MARKER = "[DONE]"
RESULT_SUMMARY_LIMIT = 200


@dataclass(frozen=True)
class SseMessage:
    event: str | None
    data: str


class SseParser:
    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._buffer = ""
        self._event: str | None = None
        self._data: list[str] = []

    def feed(self, chunk: bytes) -> list[SseMessage]:
        text = self._buffer + self._decoder.decode(chunk)
        held = ""
        if text.endswith("\r"):
            held, text = "\r", text[:-1]
        lines = LINE_BREAK.split(text)
        self._buffer = lines.pop() + held
        return self._consume(lines)

    def finish(self) -> list[SseMessage]:
        lines = LINE_BREAK.split(self._buffer + self._decoder.decode(b"", final=True))
        lines.pop()
        self._buffer = ""
        return self._consume(lines)

    def _consume(self, lines: list[str]) -> list[SseMessage]:
        messages: list[SseMessage] = []
        for line in lines:
            message = self._line(line)
            if message is not None:
                messages.append(message)
        return messages

    def _line(self, line: str) -> SseMessage | None:
        if line == "":
            return self._dispatch()
        if line.startswith(":"):
            return None
        name, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if name == "event":
            self._event = value
        elif name == "data":
            self._data.append(value)
        return None

    def _dispatch(self) -> SseMessage | None:
        message = SseMessage(self._event, "\n".join(self._data)) if self._data else None
        self._event = None
        self._data = []
        return message


def parse_data(data: str) -> JsonValue:
    stripped = data.strip()
    if not stripped.startswith(JSON_STARTS):
        return None
    try:
        parsed: JsonValue = json.loads(stripped)
    except ValueError:
        return None
    return parsed


def text_leaves(value: JsonValue) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from text_leaves(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from text_leaves(item)


def event_text(data: str) -> str:
    payload = parse_data(data)
    if payload is None:
        return data
    return "".join(text_leaves(payload))


def first_text(payload: dict[str, JsonValue], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str):
            return value
    return None


def summarise(value: JsonValue) -> str | None:
    if value is None:
        return None
    text = value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))
    return text[:RESULT_SUMMARY_LIMIT]


class ChatAggregator:
    def __init__(self) -> None:
        self._text_parts: list[str] = []
        self._final_answer: str | None = None
        self._tools: list[StepTool] = []
        self._tool_ids: list[str | None] = []
        self._cards: list[dict[str, JsonValue]] = []
        self.cost_usd = 0.0

    @property
    def answer(self) -> str | None:
        if self._text_parts:
            return "".join(self._text_parts)
        return self._final_answer

    @property
    def tools(self) -> list[StepTool]:
        return list(self._tools)

    @property
    def cards(self) -> list[dict[str, JsonValue]]:
        return list(self._cards)

    def add(self, message: SseMessage) -> None:
        if message.data.strip() == STREAM_END_MARKER:
            return
        event = (message.event or "").lower()
        if event in TEXT_EVENTS:
            self._add_text(message.data)
        elif event in TOOL_EVENTS:
            self._add_tool(message.data)
        elif event in TOOL_RESULT_EVENTS:
            self._add_tool_result(message.data)
        elif event in CARD_EVENTS:
            self._add_cards(message.data)
        elif event in DONE_EVENTS:
            self._add_done(message.data)

    def _add_text(self, data: str) -> None:
        payload = parse_data(data)
        if payload is None:
            self._text_parts.append(data)
        elif isinstance(payload, str):
            self._text_parts.append(payload)
        elif isinstance(payload, dict):
            text = first_text(payload, TEXT_KEYS)
            if text is not None:
                self._text_parts.append(text)

    def _add_tool(self, data: str) -> None:
        payload = parse_data(data)
        if not isinstance(payload, dict):
            return
        name = first_text(payload, ("name", "tool", "function"))
        if name is None:
            return
        raw_args = payload.get("args", payload.get("arguments", payload.get("input")))
        parsed_args = parse_data(raw_args) if isinstance(raw_args, str) else raw_args
        args = parsed_args if isinstance(parsed_args, dict) else {}
        summary = first_text(payload, ("result_summary", "summary")) or summarise(
            payload.get("result")
        )
        identifier = first_text(payload, ("id", "call_id"))
        self._tools.append(StepTool(name=name, args=args, result_summary=summary))
        self._tool_ids.append(identifier)

    def _add_tool_result(self, data: str) -> None:
        payload = parse_data(data)
        if not isinstance(payload, dict):
            return
        identifier = first_text(payload, ("id", "call_id"))
        name = first_text(payload, ("name", "tool"))
        summary = first_text(payload, ("result_summary", "summary")) or summarise(
            payload.get("result", payload.get("output"))
        )
        for position in range(len(self._tools) - 1, -1, -1):
            matches_id = identifier is not None and self._tool_ids[position] == identifier
            matches_name = identifier is None and self._tools[position].name == name
            if matches_id or matches_name:
                self._tools[position] = self._tools[position].model_copy(
                    update={"result_summary": summary}
                )
                return

    def _add_cards(self, data: str) -> None:
        payload = parse_data(data)
        if isinstance(payload, dict):
            self._cards.append(payload)
        elif isinstance(payload, list):
            self._cards.extend(item for item in payload if isinstance(item, dict))
        else:
            self._cards.append({"raw": data})

    def _add_done(self, data: str) -> None:
        payload = parse_data(data)
        if not isinstance(payload, dict):
            return
        final = first_text(payload, FINAL_ANSWER_KEYS)
        if final is not None:
            self._final_answer = final
        cost = payload.get("cost_usd")
        if isinstance(cost, int | float) and not isinstance(cost, bool) and cost >= 0:
            self.cost_usd = float(cost)
