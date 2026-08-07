import math
import re
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail

MAX_REPORTED_HITS = 50
MAX_EXCERPT_LENGTH = 160
REDACTION = "[REDACTED]"
MIN_ASSIGNED_SECRET_LENGTH = 8
LONG_VALUE_LENGTH = 20
MIN_ENTROPY_BITS = 3.0
MIN_BEARER_LENGTH = 20
IDENTIFIER_JOINERS = frozenset("_-.:/")

PLACEHOLDER_MARKERS = (
    "example",
    "placeholder",
    "changeme",
    "change_me",
    "change-me",
    "your-",
    "your_",
    "yourkey",
    "yourtoken",
    "redacted",
    "dummy",
    "sample",
    "fake",
    "todo",
    "replace",
    "insert",
    "xxxx",
    "****",
    "....",
    "not-a-secret",
    "not_a_secret",
    "secret_here",
    "password_here",
    "token_here",
    "key_here",
)
PLACEHOLDER_WORDS = frozenset(
    {
        "password",
        "passwd",
        "pass",
        "secret",
        "token",
        "key",
        "none",
        "null",
        "nil",
        "string",
        "str",
        "true",
        "false",
        "required",
        "optional",
        "empty",
        "test",
        "admin",
        "user",
        "undefined",
    }
)
SENSITIVE_NAME_TOKENS = frozenset({"KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "APIKEY"})
SENSITIVE_NAME_SUFFIXES = ("PASSWORD", "PASSWD", "SECRET", "TOKEN", "APIKEY")
NAME_TOKEN = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")
PATH_LIKE_VALUE = re.compile(
    r"^(?:[./~\\]|[A-Za-z]:[\\/])|\.(?:pem|key|crt|cer|json|ya?ml|txt|sql|py|sh|env)$"
)
IDENTIFIER_LIKE_VALUE = re.compile(r"^[a-z][a-z0-9]*(?:[_.\-:][a-z0-9]+)+$")
WRAPPED_PLACEHOLDER = re.compile(r"^(<[^>]*>|\{\{[^}]*\}\}|\{[^}]*\}|\[[^\]]*\]|%\([^)]*\)s)$")
EXPANDED_VARIABLE = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}|^\$[A-Za-z_][A-Za-z0-9_]*$")

AWS_ACCESS_KEY = re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b")
SK_KEY = re.compile(r"\bsk-[A-Za-z0-9_-]{20,}|\bsk_(?:live|test)_[A-Za-z0-9]{16,}")
GITHUB_TOKEN = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})")
SLACK_TOKEN = re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")
PRIVATE_KEY = re.compile(r"-----BEGIN (?:[A-Z]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----")
JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
DSN_PASSWORD = re.compile(
    r"(?<![A-Za-z0-9+.\-])[A-Za-z][A-Za-z0-9+.\-]{0,30}://[^\s:/@'\"<>]*:(?P<secret>[^\s@/'\"<>]+)@"
)
BEARER_TOKEN = re.compile(rf"\bBearer\s+(?P<secret>[A-Za-z0-9._~+/=\-]{{{MIN_BEARER_LENGTH},}})")
SENSITIVE_ASSIGNMENT = re.compile(
    r"""(?<![A-Za-z0-9_.\-])(?P<name>[A-Za-z0-9_.\-]{1,80})["']?\s*[:=]\s*["']?"""
    r"""(?P<secret>(?:\$\{[^}\s"']*\}|[^\s"'#,;}\])])+)"""
)


@dataclass(frozen=True)
class SecretHit:
    path: str
    line: int
    pattern: str
    excerpt: str


@dataclass(frozen=True)
class SpanMatch:
    pattern: str
    start: int
    end: int


def shannon_entropy(value: str) -> float:
    if not value:
        return 0.0
    counts = Counter(value)
    total = len(value)
    return -sum(count / total * math.log2(count / total) for count in counts.values())


def is_placeholder(value: str) -> bool:
    stripped = value.strip().strip("\"'`")
    if not stripped or EXPANDED_VARIABLE.search(stripped):
        return True
    if WRAPPED_PLACEHOLDER.match(stripped):
        return True
    lowered = stripped.lower()
    if lowered in PLACEHOLDER_WORDS:
        return True
    if any(marker in lowered for marker in PLACEHOLDER_MARKERS):
        return True
    return len(set(lowered)) <= 3


def is_sensitive_name(name: str) -> bool:
    tokens = [token.upper() for token in NAME_TOKEN.findall(name)]
    if tokens and tokens[-1] in SENSITIVE_NAME_TOKENS:
        return True
    return name.upper().endswith(SENSITIVE_NAME_SUFFIXES)


def has_non_joiner_symbol(value: str) -> bool:
    return any(
        not character.isalnum() and character not in IDENTIFIER_JOINERS for character in value
    )


def looks_like_real_secret(value: str) -> bool:
    if is_placeholder(value) or PATH_LIKE_VALUE.search(value) or IDENTIFIER_LIKE_VALUE.match(value):
        return False
    has_letter = any(character.isalpha() for character in value)
    has_digit = any(character.isdigit() for character in value)
    varied = has_digit or has_non_joiner_symbol(value)
    entropy = shannon_entropy(value)
    if len(value) >= LONG_VALUE_LENGTH:
        return entropy >= MIN_ENTROPY_BITS and varied
    if len(value) >= MIN_ASSIGNED_SECRET_LENGTH:
        return entropy >= MIN_ENTROPY_BITS and has_letter and varied
    return False


def literal_dsn_password(value: str) -> bool:
    return not is_placeholder(value)


def literal_bearer_token(value: str) -> bool:
    has_digit = any(character.isdigit() for character in value)
    has_letter = any(character.isalpha() for character in value)
    return (
        has_digit
        and has_letter
        and not is_placeholder(value)
        and shannon_entropy(value) >= MIN_ENTROPY_BITS
    )


FixedPattern = tuple[str, re.Pattern[str]]

FIXED_PATTERNS: tuple[FixedPattern, ...] = (
    ("aws_access_key", AWS_ACCESS_KEY),
    ("api_secret_key", SK_KEY),
    ("github_token", GITHUB_TOKEN),
    ("slack_token", SLACK_TOKEN),
    ("private_key", PRIVATE_KEY),
    ("jwt", JWT),
)
CapturingPattern = tuple[str, re.Pattern[str], Callable[[str], bool]]

CAPTURING_PATTERNS: tuple[CapturingPattern, ...] = (
    ("dsn_password", DSN_PASSWORD, literal_dsn_password),
    ("bearer_token", BEARER_TOKEN, literal_bearer_token),
)


def find_assignment_matches(line: str) -> list[SpanMatch]:
    matches: list[SpanMatch] = []
    for found in SENSITIVE_ASSIGNMENT.finditer(line):
        if is_sensitive_name(found.group("name")) and looks_like_real_secret(found.group("secret")):
            matches.append(
                SpanMatch("high_entropy_assignment", found.start("secret"), found.end("secret"))
            )
    return matches


def overlaps(first: SpanMatch, second: SpanMatch) -> bool:
    return first.start < second.end and second.start < first.end


def find_matches(line: str) -> list[SpanMatch]:
    matches: list[SpanMatch] = []
    for name, pattern in FIXED_PATTERNS:
        matches.extend(
            SpanMatch(name, found.start(), found.end()) for found in pattern.finditer(line)
        )
    for name, capturing, accepts in CAPTURING_PATTERNS:
        for found in capturing.finditer(line):
            if accepts(found.group("secret")):
                matches.append(SpanMatch(name, found.start("secret"), found.end("secret")))
    matches.extend(
        assignment
        for assignment in find_assignment_matches(line)
        if not any(overlaps(assignment, specific) for specific in matches)
    )
    return matches


def merge_spans(matches: list[SpanMatch]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for start, end in sorted({(match.start, match.end) for match in matches}):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def redact_line(line: str, matches: list[SpanMatch]) -> str:
    pieces: list[str] = []
    cursor = 0
    for start, end in merge_spans(matches):
        pieces.append(line[cursor:start])
        pieces.append(REDACTION)
        cursor = end
    pieces.append(line[cursor:])
    redacted = "".join(pieces).strip()
    if len(redacted) > MAX_EXCERPT_LENGTH:
        return f"{redacted[:MAX_EXCERPT_LENGTH]}..."
    return redacted


def scan_text(path: str, text: str) -> list[SecretHit]:
    hits: list[SecretHit] = []
    for number, line in enumerate(text.split("\n"), start=1):
        matches = find_matches(line)
        if not matches:
            continue
        excerpt = redact_line(line, matches)
        for pattern in dict.fromkeys(match.pattern for match in matches):
            hits.append(SecretHit(path=path, line=number, pattern=pattern, excerpt=excerpt))
    return hits


def scan_files(files: Mapping[str, bytes]) -> list[SecretHit]:
    hits: list[SecretHit] = []
    for path in sorted(files):
        hits.extend(scan_text(path, files[path].decode("utf-8", errors="replace")))
    return hits


def secret_rejection(hits: list[SecretHit]) -> ApiError:
    shown = hits[:MAX_REPORTED_HITS]
    details = [
        ErrorDetail(loc=["file", hit.path, hit.line], code=hit.pattern, message=hit.excerpt)
        for hit in shown
    ]
    files = len({hit.path for hit in hits})
    message = (
        f"The bundle contains {len(hits)} apparent secret(s) in {files} file(s); nothing was "
        "stored. Replace each with a ${NAME} placeholder and upload again"
    )
    return ApiError(422, "bundle_contains_secret", message, details)


def reject_secrets(files: Mapping[str, bytes]) -> None:
    hits = scan_files(files)
    if hits:
        raise secret_rejection(hits)
