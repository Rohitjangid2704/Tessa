from collections.abc import Mapping
from dataclasses import dataclass, field

from pydantic import JsonValue

from tessa_api.schemas.enums import OracleLanguage

MAX_RESULT_BYTES = 1024 * 1024
QUERY_GUARD_SECONDS = 15.0


@dataclass(frozen=True, slots=True)
class OracleLimits:
    statement_timeout_ms: int
    max_rows: int
    max_result_bytes: int = MAX_RESULT_BYTES

    @property
    def statement_timeout_seconds(self) -> float:
        return self.statement_timeout_ms / 1000

    @property
    def guard_timeout_seconds(self) -> float:
        return self.statement_timeout_seconds + QUERY_GUARD_SECONDS


@dataclass(frozen=True, slots=True)
class OracleRequest:
    language: OracleLanguage
    source: str
    dialect: str | None
    dsn: str = field(repr=False)
    params: Mapping[str, JsonValue]
    limits: OracleLimits


@dataclass(frozen=True, slots=True)
class OracleExecution:
    rows: list[dict[str, JsonValue]]
    rows_truncated: bool
    duration_ms: int
