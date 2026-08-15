import asyncio
import json
import time
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from datetime import time as clock_time
from decimal import Decimal, InvalidOperation
from typing import Any

import asyncpg
from asyncpg import exceptions as pg
from pydantic import JsonValue

from tessa_api.schemas.enums import OracleLanguage
from tessa_worker.truth.oracle_errors import OracleExecutionError, OracleFailureCode
from tessa_worker.truth.oracle_models import OracleExecution, OracleLimits, OracleRequest
from tessa_worker.truth.oracle_values import limit_rows
from tessa_worker.truth.python_oracle import run_python_oracle
from tessa_worker.truth.sql_binding import BoundQuery, bind_named_parameters

CONNECT_TIMEOUT_SECONDS = 10.0
CLOSE_TIMEOUT_SECONDS = 5.0
DSN_SCHEME = "postgresql://"
DSN_SCHEME_ALIASES = ("postgresql+asyncpg://", "postgres+asyncpg://", "postgres://")
INTEGER_TYPES = frozenset({"int2", "int4", "int8", "oid"})
FLOAT_TYPES = frozenset({"float4", "float8"})
TEXT_TYPES = frozenset({"text", "varchar", "bpchar", "name", "citext"})
JSON_TYPES = frozenset({"json", "jsonb"})
TRUE_WORDS = frozenset({"true", "t", "1", "yes"})
FALSE_WORDS = frozenset({"false", "f", "0", "no"})


def asyncpg_dsn(dsn: str) -> str:
    stripped = dsn.strip()
    for alias in DSN_SCHEME_ALIASES:
        if stripped.startswith(alias):
            return DSN_SCHEME + stripped[len(alias) :]
    return stripped


def text_argument(value: JsonValue) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def utc_datetime(value: JsonValue) -> datetime:
    moment = datetime.fromisoformat(text_argument(value))
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment


def naive_datetime(value: JsonValue) -> datetime:
    return utc_datetime(value).astimezone(UTC).replace(tzinfo=None)


def boolean_argument(value: JsonValue) -> bool:
    if isinstance(value, bool):
        return value
    word = text_argument(value).strip().lower()
    if word in TRUE_WORDS:
        return True
    if word in FALSE_WORDS:
        return False
    raise ValueError(f"{word!r} is not a boolean")


def integer_argument(value: JsonValue) -> int:
    if isinstance(value, bool):
        raise ValueError("a boolean is not an integer")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f"{value} is not a whole number")
    return int(value) if isinstance(value, int | float) else int(text_argument(value).strip())


def coerce_argument(type_name: str, value: JsonValue) -> Any:
    if value is None:
        return None
    if type_name == "date":
        return date.fromisoformat(text_argument(value))
    if type_name == "timestamptz":
        return utc_datetime(value)
    if type_name == "timestamp":
        return naive_datetime(value)
    if type_name == "time":
        return clock_time.fromisoformat(text_argument(value))
    if type_name in INTEGER_TYPES:
        return integer_argument(value)
    if type_name in FLOAT_TYPES:
        return float(value) if isinstance(value, int | float) else float(text_argument(value))
    if type_name == "numeric":
        return Decimal(text_argument(value).strip())
    if type_name == "bool":
        return boolean_argument(value)
    if type_name in TEXT_TYPES or type_name in JSON_TYPES:
        return text_argument(value)
    return value


def build_arguments(
    bound: BoundQuery, params: Mapping[str, JsonValue], parameter_types: Sequence[Any]
) -> list[Any]:
    missing = [name for name in bound.parameter_names if name not in params]
    if missing:
        raise OracleExecutionError(
            OracleFailureCode.parameter_missing,
            f"the query needs parameters that were not given: {', '.join(missing)}",
        )
    arguments: list[Any] = []
    for name, parameter_type in zip(bound.parameter_names, parameter_types, strict=True):
        try:
            arguments.append(coerce_argument(str(parameter_type.name), params[name]))
        except (ValueError, TypeError, InvalidOperation, OverflowError) as error:
            raise OracleExecutionError(
                OracleFailureCode.parameter_invalid,
                f"parameter {name!r} does not fit the column type {parameter_type.name}: "
                f"{str(error)[:120]}",
            ) from None
    return arguments


async def fetch_sql_rows(
    connection: Any, bound: BoundQuery, params: Mapping[str, JsonValue], limits: OracleLimits
) -> tuple[list[dict[str, JsonValue]], bool]:
    timeout_statement = f"SET LOCAL statement_timeout = {int(limits.statement_timeout_ms)}"
    async with connection.transaction(readonly=True):
        await connection.execute(timeout_statement)
        statement = await connection.prepare(bound.sql)
        arguments = build_arguments(bound, params, statement.get_parameters())
        cursor = await statement.cursor(*arguments)
        records = await cursor.fetch(limits.max_rows + 1)
    return limit_rows(
        (dict(record) for record in records), limits.max_rows, limits.max_result_bytes
    )


def postgres_failure(error: pg.PostgresError, limits: OracleLimits) -> OracleExecutionError:
    state = f" (SQLSTATE {error.sqlstate})" if error.sqlstate else ""
    if isinstance(error, pg.QueryCanceledError):
        return OracleExecutionError(
            OracleFailureCode.timeout,
            f"the query exceeded the statement timeout of {limits.statement_timeout_ms} ms",
        )
    if isinstance(error, pg.ReadOnlySQLTransactionError | pg.InsufficientPrivilegeError):
        return OracleExecutionError(
            OracleFailureCode.read_only_violation,
            f"the database refused the query because it is not read-only{state}: {error.message}",
        )
    if isinstance(
        error,
        pg.PostgresConnectionError
        | pg.InvalidAuthorizationSpecificationError
        | pg.InvalidPasswordError
        | pg.CannotConnectNowError,
    ):
        return OracleExecutionError(
            OracleFailureCode.connection_failed,
            f"the truth database refused the connection{state}",
        )
    if isinstance(error, pg.DataError):
        return OracleExecutionError(
            OracleFailureCode.parameter_invalid, f"a parameter was rejected{state}: {error.message}"
        )
    return OracleExecutionError(
        OracleFailureCode.query_failed, f"{type(error).__name__}{state}: {error.message}"
    )


async def open_connection(dsn: str) -> Any:
    try:
        return await asyncpg.connect(asyncpg_dsn(dsn), timeout=CONNECT_TIMEOUT_SECONDS)
    except pg.PostgresError as error:
        raise OracleExecutionError(
            OracleFailureCode.connection_failed,
            f"could not connect to the truth database ({type(error).__name__})",
        ) from None
    except (OSError, asyncpg.InterfaceError, ValueError) as error:
        raise OracleExecutionError(
            OracleFailureCode.connection_failed,
            f"could not connect to the truth database ({type(error).__name__})",
        ) from None


async def close_quietly(connection: Any) -> None:
    try:
        await connection.close(timeout=CLOSE_TIMEOUT_SECONDS)
    except (pg.PostgresError, asyncpg.InterfaceError, OSError, TimeoutError):
        connection.terminate()


async def query_truth_database(
    request: OracleRequest, bound: BoundQuery
) -> tuple[list[dict[str, JsonValue]], bool]:
    connection = await open_connection(request.dsn)
    try:
        return await fetch_sql_rows(connection, bound, request.params, request.limits)
    except pg.PostgresError as error:
        raise postgres_failure(error, request.limits) from None
    except asyncpg.InterfaceError as error:
        raise OracleExecutionError(
            OracleFailureCode.query_failed, f"the database interface failed: {error}"
        ) from None
    finally:
        await close_quietly(connection)


async def run_sql_oracle(request: OracleRequest) -> OracleExecution:
    bound = bind_named_parameters(request.source, request.dialect)
    started = time.perf_counter()
    try:
        async with asyncio.timeout(request.limits.guard_timeout_seconds):
            rows, truncated = await query_truth_database(request, bound)
    except TimeoutError:
        raise OracleExecutionError(
            OracleFailureCode.timeout,
            f"the query did not finish within {request.limits.guard_timeout_seconds:g} seconds",
        ) from None
    return OracleExecution(rows, truncated, round((time.perf_counter() - started) * 1000))


async def execute_oracle(request: OracleRequest) -> OracleExecution:
    if request.language is OracleLanguage.sql:
        return await run_sql_oracle(request)
    return await run_python_oracle(request)
