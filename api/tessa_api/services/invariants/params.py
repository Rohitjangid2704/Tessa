import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

from tessa_api.schemas.scenario import (
    REQUEST_PATH_PATTERN,
    HttpMethod,
    QueryValue,
)

logger = logging.getLogger("tessa_api.invariants")

MAX_PATTERN_LENGTH = 200
MAX_PATTERNS = 50
MAX_FIELD_NAMES = 100
LATENCY_LIMIT_KEY = "max_ms"
CONSOLE_ALLOW_KEY = "allow"
PII_ROLES_KEY = "roles"
ALL_ROLES_KEY = "*"
FOREIGN_REQUESTS_KEY = "foreign_requests"
DENIED_STATUSES_KEY = "denied_statuses"
MIN_STATUS = 100
MAX_STATUS = 599
UNAUTHENTICATED_DENIAL_STATUSES = frozenset({401, 403})
FORBIDDEN_DENIAL_STATUSES = frozenset({401, 403, 404})
WRITE_SUCCESS_STATUSES = frozenset({200, 201, 202, 204})
REPLAY_ACCEPTED_STATUSES = frozenset({*WRITE_SUCCESS_STATUSES, 409})


@lru_cache(maxsize=512)
def compile_pattern(pattern: str) -> re.Pattern[str] | None:
    if not pattern or len(pattern) > MAX_PATTERN_LENGTH:
        return None
    try:
        return re.compile(pattern)
    except re.error:
        return None


def string_items(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def usable_patterns(value: object) -> tuple[re.Pattern[str], ...]:
    compiled: list[re.Pattern[str]] = []
    for text in string_items(value)[:MAX_PATTERNS]:
        pattern = compile_pattern(text)
        if pattern is None:
            logger.warning("invariant_pattern_ignored", extra={"reason": "not a usable regex"})
        elif pattern not in compiled:
            compiled.append(pattern)
    return tuple(compiled)


def latency_limit_ms(params: Mapping[str, JsonValue]) -> int | None:
    value = params.get(LATENCY_LIMIT_KEY)
    if isinstance(value, bool) or not isinstance(value, int | float) or value <= 0:
        return None
    return int(value)


def console_allow_patterns(params: Mapping[str, JsonValue]) -> tuple[re.Pattern[str], ...]:
    return usable_patterns(params.get(CONSOLE_ALLOW_KEY))


def denied_statuses(params: Mapping[str, JsonValue], default: frozenset[int]) -> frozenset[int]:
    value = params.get(DENIED_STATUSES_KEY)
    if not isinstance(value, list):
        return default
    statuses = frozenset(
        item
        for item in value
        if isinstance(item, int) and not isinstance(item, bool) and MIN_STATUS <= item <= MAX_STATUS
    )
    return statuses or default


class PiiRoleRules(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    fields: list[str] = Field(default_factory=list, max_length=MAX_FIELD_NAMES)
    patterns: list[str] = Field(default_factory=list, max_length=MAX_PATTERNS)


@dataclass(frozen=True, slots=True)
class PiiRules:
    fields: frozenset[str]
    patterns: tuple[re.Pattern[str], ...]

    @property
    def declared(self) -> bool:
        return bool(self.fields) or bool(self.patterns)


def role_rules(raw: JsonValue) -> PiiRoleRules | None:
    if raw is None:
        return None
    try:
        return PiiRoleRules.model_validate(raw)
    except ValidationError:
        logger.warning("pii_rules_ignored", extra={"reason": "not a valid rule set"})
        return None


def declared_pii_rules(params: Mapping[str, JsonValue], role: str) -> PiiRules:
    roles = params.get(PII_ROLES_KEY)
    if not isinstance(roles, dict):
        return PiiRules(frozenset(), ())
    fields: set[str] = set()
    patterns: list[re.Pattern[str]] = []
    for key in (ALL_ROLES_KEY, role):
        rules = role_rules(roles.get(key))
        if rules is None:
            continue
        fields.update(name.casefold() for name in rules.fields if name)
        patterns.extend(
            pattern for pattern in usable_patterns(rules.patterns) if pattern not in patterns
        )
    return PiiRules(frozenset(fields), tuple(patterns))


class ForeignRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    interface_id: str | None = Field(default=None, alias="interface")
    method: HttpMethod = "GET"
    path: str = Field(pattern=REQUEST_PATH_PATTERN)
    query: dict[str, QueryValue] = Field(default_factory=dict)
    body: JsonValue = None
    description: str | None = Field(default=None, max_length=200)


@dataclass(frozen=True, slots=True)
class ForeignRequests:
    requests: tuple[ForeignRequest, ...]
    problems: tuple[str, ...]


def declared_foreign_requests(params: Mapping[str, JsonValue]) -> ForeignRequests:
    raw = params.get(FOREIGN_REQUESTS_KEY)
    if not isinstance(raw, list):
        return ForeignRequests((), ())
    requests: list[ForeignRequest] = []
    problems: list[str] = []
    for index, item in enumerate(raw):
        try:
            requests.append(ForeignRequest.model_validate(item))
        except ValidationError as error:
            first = error.errors()[0]
            location = ".".join(str(part) for part in first["loc"])
            problems.append(f"{FOREIGN_REQUESTS_KEY}[{index}] {location}: {first['msg']}")
    return ForeignRequests(tuple(requests), tuple(problems))
