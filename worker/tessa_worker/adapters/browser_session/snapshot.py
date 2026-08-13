import hashlib
import re
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from tessa_api.ids import new_id
from tessa_api.schemas.enums import ArtifactKind
from tessa_api.schemas.explore_actions import ELEMENT_NAME_MAX_CHARS, ElementRef
from tessa_api.services.artifact_store import ArtifactNotFoundError, ArtifactStore
from tessa_worker.lab.contracts import FailedRequest, PageSnapshot

ADDRESSABLE_ROLES = frozenset(
    {
        "link",
        "button",
        "textbox",
        "searchbox",
        "checkbox",
        "radio",
        "combobox",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "tab",
        "switch",
        "option",
        "slider",
        "spinbutton",
        "treeitem",
    }
)
TEXT_ENTRY_ROLES = frozenset({"textbox", "searchbox", "combobox", "spinbutton"})
SNAPSHOT_STORE_MAX_CHARS = 200_000
SNAPSHOT_MIME = "application/json"
READ_HEADER = "## text read from the page"
TRUNCATION_MARKER = "[... snapshot cut ...]"
DIGEST_CHARS = 24
MAX_FAILED_REQUESTS = 20
MAX_CONSOLE_ERRORS = 20
CONSOLE_ERROR_CHARS = 300

ROLE_PATTERN = re.compile(r"^(?P<role>[a-z][a-z0-9-]*)")
NAME_PATTERN = re.compile(r'^ "(?P<name>(?:[^"\\]|\\.)*)"')
ATTRIBUTE_PATTERN = re.compile(r"^ \[[^\]]*\]")
ESCAPE_PATTERN = re.compile(r"\\(.)")
WHITESPACE_PATTERN = re.compile(r"\s+")
ESCAPES = {"n": "\n", "t": "\t", "r": "\r"}


@dataclass(frozen=True, slots=True)
class SnapshotLine:
    role: str
    name: str
    key_end: int


class StoredSnapshot(BaseModel):
    model_config = ConfigDict(frozen=True)

    url: str
    title: str
    text: str
    digest: str
    new_console_errors: list[str]
    failed_requests: list[tuple[str, str, int]]


def normalise_name(text: str) -> str:
    return WHITESPACE_PATTERN.sub(" ", text).strip()


def unescape(text: str) -> str:
    return ESCAPE_PATTERN.sub(lambda match: ESCAPES.get(match.group(1), match.group(1)), text)


def key_end_of(body: str) -> int:
    in_quote = False
    in_attribute = False
    position = 0
    while position < len(body):
        character = body[position]
        if in_quote:
            if character == "\\":
                position += 2
                continue
            in_quote = character != '"'
        elif in_attribute:
            in_attribute = character != "]"
        elif character == '"':
            in_quote = True
        elif character == "[":
            in_attribute = True
        elif character == ":" and (position + 1 == len(body) or body[position + 1] == " "):
            return position
        position += 1
    return len(body)


def unquoted_key(body: str) -> tuple[str, int] | None:
    if not body.startswith("'"):
        return body, 0
    closing = 1
    while closing < len(body):
        if body[closing] == "'":
            if closing + 1 < len(body) and body[closing + 1] == "'":
                closing += 2
                continue
            return body[1:closing].replace("''", "'"), closing + 1
        closing += 1
    return None


def parse_snapshot_line(line: str) -> SnapshotLine | None:
    stripped = line.lstrip(" ")
    if not stripped.startswith("- "):
        return None
    offset = len(line) - len(stripped) + 2
    body = stripped[2:]
    quoted = unquoted_key(body)
    if quoted is None:
        return None
    key_text, consumed = quoted
    if consumed:
        key_end = offset + consumed
    else:
        key_end = offset + key_end_of(body)
        key_text = body[: key_end - offset]
    role_match = ROLE_PATTERN.match(key_text)
    if role_match is None:
        return None
    remainder = key_text[role_match.end() :]
    name = ""
    name_match = NAME_PATTERN.match(remainder)
    if name_match is not None:
        name = normalise_name(unescape(name_match.group("name")))
        remainder = remainder[name_match.end() :]
    attribute = ATTRIBUTE_PATTERN.match(remainder)
    while attribute is not None:
        remainder = remainder[attribute.end() :]
        attribute = ATTRIBUTE_PATTERN.match(remainder)
    if remainder.strip():
        return None
    return SnapshotLine(role=role_match.group("role"), name=name, key_end=key_end)


def addressable_lines(text: str) -> list[tuple[int, SnapshotLine]]:
    found: list[tuple[int, SnapshotLine]] = []
    for position, line in enumerate(text.splitlines()):
        parsed = parse_snapshot_line(line)
        if (
            parsed is not None
            and parsed.role in ADDRESSABLE_ROLES
            and parsed.name
            and len(parsed.name) <= ELEMENT_NAME_MAX_CHARS
        ):
            found.append((position, parsed))
    return found


def elements_of(text: str) -> list[ElementRef]:
    seen: Counter[tuple[str, str]] = Counter()
    elements: list[ElementRef] = []
    for _, parsed in addressable_lines(text):
        identity = (parsed.role, parsed.name)
        elements.append(ElementRef(role=parsed.role, name=parsed.name, index=seen[identity]))
        seen[identity] += 1
    return elements


def has_element(text: str, target: ElementRef) -> bool:
    wanted = ElementRef(role=target.role, name=normalise_name(target.name), index=target.index)
    return wanted in elements_of(text)


def annotate_duplicates(aria: str) -> str:
    lines = aria.splitlines()
    totals = Counter((parsed.role, parsed.name) for _, parsed in addressable_lines(aria))
    seen: Counter[tuple[str, str]] = Counter()
    for position, parsed in addressable_lines(aria):
        identity = (parsed.role, parsed.name)
        if totals[identity] > 1:
            line = lines[position]
            marker = f" [index={seen[identity]}]"
            lines[position] = line[: parsed.key_end] + marker + line[parsed.key_end :]
        seen[identity] += 1
    return "\n".join(lines)


def limit_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - len(TRUNCATION_MARKER) - 1)] + "\n" + TRUNCATION_MARKER


def snapshot_text(aria: str, read_text: str | None) -> str:
    annotated = annotate_duplicates(aria)
    if not read_text or not read_text.strip():
        return annotated
    return f"{annotated}\n\n{READ_HEADER}\n{read_text.strip()}"


def digest_of(url: str, text: str) -> str:
    material = f"{url}\n{WHITESPACE_PATTERN.sub(' ', text).strip()}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:DIGEST_CHARS]


def build_snapshot(
    url: str,
    title: str,
    aria: str,
    read_text: str | None,
    console_errors: Sequence[str],
    failed_requests: Sequence[FailedRequest],
    redact: Callable[[str], str],
) -> PageSnapshot:
    safe_url = redact(url)
    text = limit_text(redact(snapshot_text(aria, read_text)), SNAPSHOT_STORE_MAX_CHARS)
    return PageSnapshot(
        ref="",
        url=safe_url,
        title=redact(title),
        text=text,
        digest=digest_of(safe_url, text),
        new_console_errors=tuple(
            redact(error)[:CONSOLE_ERROR_CHARS] for error in console_errors[:MAX_CONSOLE_ERRORS]
        ),
        failed_requests=tuple(
            FailedRequest(request.method, redact(request.url), request.status)
            for request in failed_requests[:MAX_FAILED_REQUESTS]
        ),
    )


def to_stored(snapshot: PageSnapshot) -> StoredSnapshot:
    return StoredSnapshot(
        url=snapshot.url,
        title=snapshot.title,
        text=snapshot.text,
        digest=snapshot.digest,
        new_console_errors=list(snapshot.new_console_errors),
        failed_requests=[
            (request.method, request.url, request.status) for request in snapshot.failed_requests
        ],
    )


def from_stored(ref: str, stored: StoredSnapshot) -> PageSnapshot:
    return PageSnapshot(
        ref=ref,
        url=stored.url,
        title=stored.title,
        text=stored.text,
        digest=stored.digest,
        new_console_errors=tuple(stored.new_console_errors),
        failed_requests=tuple(
            FailedRequest(method, url, status) for method, url, status in stored.failed_requests
        ),
    )


class SnapshotNotFoundError(LookupError):
    pass


class SnapshotStore:
    def __init__(self, artifacts: ArtifactStore) -> None:
        self.artifacts = artifacts

    async def save(self, snapshot: PageSnapshot) -> PageSnapshot:
        artifact_id = new_id()
        content = to_stored(snapshot).model_dump_json().encode("utf-8")
        await self.artifacts.put(artifact_id, content, ArtifactKind.report_json, SNAPSHOT_MIME)
        return PageSnapshot(
            ref=str(artifact_id),
            url=snapshot.url,
            title=snapshot.title,
            text=snapshot.text,
            digest=snapshot.digest,
            new_console_errors=snapshot.new_console_errors,
            failed_requests=snapshot.failed_requests,
        )

    async def load(self, ref: str) -> PageSnapshot:
        try:
            artifact_id = UUID(ref)
            opened = await self.artifacts.open(artifact_id)
        except (ValueError, ArtifactNotFoundError):
            raise SnapshotNotFoundError(f"snapshot {ref} is not stored") from None
        content = b"".join([chunk async for chunk in opened.chunks])
        return from_stored(ref, StoredSnapshot.model_validate_json(content))

    async def delete(self, ref: str) -> None:
        try:
            await self.artifacts.delete(UUID(ref))
        except ValueError:
            return
