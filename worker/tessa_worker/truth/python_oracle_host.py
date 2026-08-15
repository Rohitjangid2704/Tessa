import asyncio
import importlib.util
import inspect
import json
import os
import sys
import threading
from collections.abc import Callable, Coroutine, Mapping
from datetime import date, datetime, time
from decimal import Decimal
from types import ModuleType
from typing import Any

DSN_VARIABLE = "ORACLE_TRUTH_DSN"
STATEMENT_TIMEOUT_VARIABLE = "ORACLE_STATEMENT_TIMEOUT_MS"
ENTRY_POINT = "run"
FAILURE_EXIT_CODE = 3
MODULE_NAME = "oracle_source"
DSN_ALIASES = ("postgresql+asyncpg://", "postgres+asyncpg://", "postgres://")


def asyncpg_dsn(dsn: str) -> str:
    for alias in DSN_ALIASES:
        if dsn.startswith(alias):
            return "postgresql://" + dsn[len(alias) :]
    return dsn


def encode_unknown(value: object) -> object:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    if isinstance(value, bytes | bytearray | memoryview):
        return "\\x" + bytes(value).hex()
    return str(value)


def record_to_row(record: object) -> dict[str, Any]:
    if isinstance(record, Mapping):
        return {str(key): value for key, value in record.items()}
    raise TypeError("run must return a list of row objects (dictionaries)")


class AsyncConnection:
    def __init__(self, connection: Any) -> None:
        self._connection = connection

    async def fetch(self, sql: str, *arguments: object) -> list[dict[str, Any]]:
        return [dict(record) for record in await self._connection.fetch(sql, *arguments)]

    async def fetchrow(self, sql: str, *arguments: object) -> dict[str, Any] | None:
        record = await self._connection.fetchrow(sql, *arguments)
        return dict(record) if record is not None else None

    async def fetchval(self, sql: str, *arguments: object) -> Any:
        return await self._connection.fetchval(sql, *arguments)

    async def close(self) -> None:
        await self._connection.close()

    async def __aenter__(self) -> "AsyncConnection":
        return self

    async def __aexit__(self, *exception: object) -> None:
        await self.close()


class LoopThread:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

    def call[T](self, coroutine: Coroutine[Any, Any, T]) -> T:
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result()


class SyncConnection:
    def __init__(self, loop_thread: LoopThread, connection: AsyncConnection) -> None:
        self._loop_thread = loop_thread
        self._connection = connection

    def fetch(self, sql: str, *arguments: object) -> list[dict[str, Any]]:
        return self._loop_thread.call(self._connection.fetch(sql, *arguments))

    def fetchrow(self, sql: str, *arguments: object) -> dict[str, Any] | None:
        return self._loop_thread.call(self._connection.fetchrow(sql, *arguments))

    def fetchval(self, sql: str, *arguments: object) -> Any:
        return self._loop_thread.call(self._connection.fetchval(sql, *arguments))

    def close(self) -> None:
        self._loop_thread.call(self._connection.close())

    def __enter__(self) -> "SyncConnection":
        return self

    def __exit__(self, *exception: object) -> None:
        self.close()


async def open_async_connection() -> AsyncConnection:
    import asyncpg

    dsn = os.environ[DSN_VARIABLE]
    timeout_ms = os.environ.get(STATEMENT_TIMEOUT_VARIABLE, "10000")
    connection = await asyncpg.connect(
        asyncpg_dsn(dsn),
        server_settings={
            "default_transaction_read_only": "on",
            "statement_timeout": timeout_ms,
        },
    )
    return AsyncConnection(connection)


def load_oracle_module(path: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(MODULE_NAME, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load the oracle from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_synchronously(run: Callable[..., Any], params: dict[str, Any]) -> Any:
    loop_thread = LoopThread()

    def connect() -> SyncConnection:
        return SyncConnection(loop_thread, loop_thread.call(open_async_connection()))

    return run(params, connect)


async def run_asynchronously(run: Callable[..., Any], params: dict[str, Any]) -> Any:
    return await run(params, open_async_connection)


def execute(path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    run = getattr(load_oracle_module(path), ENTRY_POINT, None)
    if not callable(run):
        raise AttributeError(f"the oracle does not define {ENTRY_POINT}(params, connect)")
    if inspect.iscoroutinefunction(run):
        outcome = asyncio.run(run_asynchronously(run, params))
    else:
        outcome = run_synchronously(run, params)
    if not isinstance(outcome, list | tuple):
        raise TypeError("run must return a list of row objects (dictionaries)")
    return [record_to_row(record) for record in outcome]


def write_outcome(stream: Any, outcome: dict[str, Any]) -> None:
    stream.write(json.dumps(outcome, default=encode_unknown, ensure_ascii=False))
    stream.flush()


def main() -> int:
    result_stream = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
    sys.stdout = sys.stderr
    try:
        params = json.loads(sys.stdin.read())["params"]
        write_outcome(result_stream, {"rows": execute(sys.argv[1], params)})
    except Exception as error:
        write_outcome(result_stream, {"error": f"{type(error).__name__}: {error}"[:2000]})
        return FAILURE_EXIT_CODE
    return 0


if __name__ == "__main__":
    sys.exit(main())
