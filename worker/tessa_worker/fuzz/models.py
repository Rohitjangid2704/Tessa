from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum


class FuzzStop(StrEnum):
    completed = "completed"
    time_limit = "time_limit"
    failure_limit = "failure_limit"
    server_unavailable = "server_unavailable"
    interrupted = "interrupted"
    engine_failed = "engine_failed"


@dataclass(frozen=True, slots=True)
class FuzzRunConfig:
    origin: str | None
    base_url: str | None
    headers: Mapping[str, str] = field(repr=False)
    seed: int
    max_examples: int
    max_seconds: int
    request_timeout_seconds: float
    max_failures: int
    safe_methods_only: bool
    read_limit_bytes: int


@dataclass(frozen=True, slots=True)
class CapturedRequest:
    method: str
    url: str
    headers: Mapping[str, str] = field(repr=False)
    body: bytes | None = field(repr=False)


@dataclass(frozen=True, slots=True)
class CapturedResponse:
    status_code: int
    headers: Mapping[str, str] = field(repr=False)
    content: bytes = field(repr=False)
    truncated: bool
    elapsed_ms: int


@dataclass(frozen=True, slots=True)
class CollectedFailure:
    operation: str
    check: str
    title: str
    message: str
    request: CapturedRequest | None
    response: CapturedResponse | None


@dataclass(slots=True)
class FuzzOutcome:
    cases_run: int
    operations: int
    failures: list[CollectedFailure]
    notes: list[str]
    stop: FuzzStop
    seed: int
    elapsed_ms: int

    @property
    def incomplete(self) -> bool:
        return self.stop is not FuzzStop.completed
