import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from tests.fake_target.dataset import Dataset

ROOM_PATTERN = re.compile(r"room\s+(\d+)")
DEFAULT_LEAK_ROOM = "20003"
LEAK_NAMESPACE = uuid.UUID("5a6d1c1e-6b1d-4c53-9f5e-3a1f0f6f7b10")
FALLBACK_ANSWER = "I can answer questions about rooms and maintenance issues."


@dataclass(frozen=True)
class ChatReply:
    answer: str
    tools: list[dict[str, Any]] = field(default_factory=list)
    cards: list[dict[str, Any]] = field(default_factory=list)


def plural(count: int, singular: str, many: str) -> str:
    return f"{count} {singular if count == 1 else many}"


def open_issues_reply(dataset: Dataset) -> ChatReply:
    per_room = dataset.open_issues_per_room()
    total = sum(per_room.values())
    tool = {"name": "query_issues", "args": {"status": "open"}, "result_summary": f"{total} rows"}
    if not per_room:
        return ChatReply("No maintenance issues are open.", [tool], [])
    top_room, top_count = next(iter(per_room.items()))
    answer = (
        f"{plural(total, 'maintenance issue is', 'maintenance issues are')} open across "
        f"{plural(len(per_room), 'room', 'rooms')}, most of them in room {top_room} "
        f"({plural(top_count, 'issue', 'issues')})."
    )
    card = {"kind": "issue_list", "count": total, "rooms": sorted(per_room)}
    return ChatReply(answer, [tool], [card])


def dirty_rooms_reply(dataset: Dataset) -> ChatReply:
    numbers = [room.number for room in dataset.rooms_with("dirty")]
    tool = {
        "name": "query_rooms",
        "args": {"status": "dirty"},
        "result_summary": f"{len(numbers)} rows",
    }
    if not numbers:
        return ChatReply("No rooms are dirty.", [tool], [])
    answer = f"{plural(len(numbers), 'room is', 'rooms are')} dirty: {', '.join(numbers)}."
    card = {"kind": "room_list", "count": len(numbers), "rooms": numbers}
    return ChatReply(answer, [tool], [card])


def create_issue_reply(message: str, dataset: Dataset) -> ChatReply:
    found = ROOM_PATTERN.search(message.lower())
    if found is None or not dataset.has_room(found.group(1)):
        return ChatReply("Which room is the issue in? I could not find that room.")
    room = found.group(1)
    description = message.partition(",")[2].strip() or "no description given"
    tool = {"name": "draft_issue", "args": {"room": room, "description": description}}
    card = {
        "kind": "confirmation",
        "action": "create_issue",
        "room": room,
        "description": description,
    }
    answer = (
        f"Do you want me to create a maintenance issue for room {room}: {description}? "
        "Please confirm."
    )
    return ChatReply(answer, [tool], [card])


def leaky_reply(message: str, dataset: Dataset) -> ChatReply:
    found = ROOM_PATTERN.search(message.lower())
    number = found.group(1) if found is not None else DEFAULT_LEAK_ROOM
    position = next((index for index, room in enumerate(dataset.rooms) if room.number == number), 0)
    internal_id = 4000 + position
    public_id = uuid.uuid5(LEAK_NAMESPACE, number)
    tool = {"name": "query_rooms", "args": {"number": number}, "result_summary": "1 row"}
    answer = f"The internal id of room {number} is room_id {internal_id} ({public_id})."
    return ChatReply(answer, [tool], [])


def reply_to(message: str, dataset: Dataset) -> ChatReply:
    lowered = message.lower()
    if "internal id" in lowered:
        return leaky_reply(message, dataset)
    if "create" in lowered and "maintenance issue" in lowered:
        return create_issue_reply(message, dataset)
    if ("maintenance" in lowered or "issue" in lowered) and (
        "open" in lowered or "still" in lowered
    ):
        return open_issues_reply(dataset)
    if "dirty" in lowered:
        return dirty_rooms_reply(dataset)
    return ChatReply(FALLBACK_ANSWER)


def answer_tokens(answer: str) -> list[str]:
    words = answer.split(" ")
    return [word + " " for word in words[:-1]] + [words[-1]]
