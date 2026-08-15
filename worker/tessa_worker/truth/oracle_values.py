import json
import math
from collections.abc import Iterable, Mapping
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from uuid import UUID

from pydantic import JsonValue

MAX_DEPTH = 8
BYTES_PREFIX = "\\x"


def decimal_value(value: Decimal) -> JsonValue:
    if not value.is_finite():
        return str(value)
    if value == value.to_integral_value():
        return int(value)
    return float(value)


def float_value(value: float) -> JsonValue:
    return value if math.isfinite(value) else str(value)


def json_value(value: object, depth: int = 0) -> JsonValue:
    if value is None or isinstance(value, bool | int | str):
        return value
    if isinstance(value, float):
        return float_value(value)
    if isinstance(value, Decimal):
        return decimal_value(value)
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    if isinstance(value, timedelta):
        return str(value)
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, bytes | bytearray | memoryview):
        return BYTES_PREFIX + bytes(value).hex()
    if depth >= MAX_DEPTH:
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): json_value(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        return [json_value(item, depth + 1) for item in value]
    return str(value)


def json_row(row: Mapping[str, object]) -> dict[str, JsonValue]:
    return {str(name): json_value(value) for name, value in row.items()}


def encoded_size(row: Mapping[str, JsonValue]) -> int:
    return len(json.dumps(row, ensure_ascii=False).encode("utf-8"))


def limit_rows(
    rows: Iterable[Mapping[str, object]], max_rows: int, max_bytes: int
) -> tuple[list[dict[str, JsonValue]], bool]:
    kept: list[dict[str, JsonValue]] = []
    size = 0
    for row in rows:
        if len(kept) >= max_rows:
            return kept, True
        converted = json_row(row)
        size += encoded_size(converted)
        if size > max_bytes:
            return kept, True
        kept.append(converted)
    return kept, False
