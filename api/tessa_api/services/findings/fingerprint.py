import hashlib
import re
from collections.abc import Sequence
from urllib.parse import urlsplit
from uuid import UUID

from tessa_api.schemas.enums import FindingClass
from tessa_api.services.grading_rules import clip_text

SIGNAL_LIMIT = 300
FIELD_SEPARATOR = "|"
ABSENT_FIELD = "-"
ID_SEGMENT = "{id}"
UUID_TOKEN = "<uuid>"
TIMESTAMP_TOKEN = "<ts>"
TIME_TOKEN = "<time>"
HEX_TOKEN = "<hex>"
NUMBER_TOKEN = "<n>"
MIN_OPAQUE_SEGMENT_LENGTH = 8
UUID_TEXT = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

UUID_PATTERN = re.compile(rf"\b{UUID_TEXT}\b")
UUID_SEGMENT = re.compile(UUID_TEXT)
TIMESTAMP_PATTERN = re.compile(
    r"\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?(?!\d)"
)
TIME_PATTERN = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\b")
HEX_PATTERN = re.compile(r"\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b")
NUMBER_PATTERN = re.compile(r"\d+(?:[.,]\d+)*")
WHITESPACE_PATTERN = re.compile(r"\s+")

NORMALIZERS: tuple[tuple[re.Pattern[str], str], ...] = (
    (UUID_PATTERN, UUID_TOKEN),
    (TIMESTAMP_PATTERN, TIMESTAMP_TOKEN),
    (TIME_PATTERN, TIME_TOKEN),
    (HEX_PATTERN, HEX_TOKEN),
    (NUMBER_PATTERN, NUMBER_TOKEN),
)


def normalize_signal(text: str, limit: int = SIGNAL_LIMIT) -> str:
    normalized = text.lower()
    for pattern, token in NORMALIZERS:
        normalized = pattern.sub(token, normalized)
    return clip_text(WHITESPACE_PATTERN.sub(" ", normalized).strip(), limit)


def is_identifier_segment(segment: str) -> bool:
    if not segment:
        return False
    if segment.isdigit() or UUID_SEGMENT.fullmatch(segment.lower()):
        return True
    return len(segment) >= MIN_OPAQUE_SEGMENT_LENGTH and any(
        character.isdigit() for character in segment
    )


def path_template(address: str) -> str:
    path = urlsplit(address).path or "/"
    segments = [
        ID_SEGMENT if is_identifier_segment(segment) else segment for segment in path.split("/")
    ]
    return "/".join(segments)


def request_target(method: str | None, address: str | None) -> str:
    verb = method.upper() if method else ABSENT_FIELD
    template = path_template(address) if address else ABSENT_FIELD
    return f"{verb} {template}"


def server_error_signal(status: int, target: str) -> str:
    return f"{status} {target}"


def fingerprint_fields(
    target_id: UUID,
    finding_class: FindingClass,
    check: str,
    feature_id: str | None,
    interface_id: str | None,
    role: str | None,
    signal: str,
) -> Sequence[str]:
    return (
        str(target_id),
        finding_class.value,
        check,
        feature_id or ABSENT_FIELD,
        interface_id or ABSENT_FIELD,
        role or ABSENT_FIELD,
        signal,
    )


def compute_fingerprint(
    target_id: UUID,
    finding_class: FindingClass,
    check: str,
    feature_id: str | None,
    interface_id: str | None,
    role: str | None,
    signal: str,
) -> str:
    joined = FIELD_SEPARATOR.join(
        fingerprint_fields(target_id, finding_class, check, feature_id, interface_id, role, signal)
    )
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()
