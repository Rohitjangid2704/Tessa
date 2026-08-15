import asyncio
import json
import os
import sys
import tempfile
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from tessa_worker.truth.environment import BASE_VARIABLE_NAMES
from tessa_worker.truth.oracle_errors import OracleExecutionError, OracleFailureCode
from tessa_worker.truth.oracle_models import OracleExecution, OracleRequest
from tessa_worker.truth.oracle_values import limit_rows
from tessa_worker.truth.process import TailBuffer, drain, terminate

HOST_SCRIPT = Path(__file__).with_name("python_oracle_host.py")
SOURCE_FILE_NAME = "oracle_source.py"
DSN_VARIABLE = "ORACLE_TRUTH_DSN"
STATEMENT_TIMEOUT_VARIABLE = "ORACLE_STATEMENT_TIMEOUT_MS"
STDOUT_LIMIT_BYTES = 2 * 1024 * 1024
STDERR_TAIL_BYTES = 2048
READ_CHUNK_BYTES = 65536
PROCESS_START_ALLOWANCE_SECONDS = 5.0
READER_GRACE_SECONDS = 2.0
ISOLATED_INTERPRETER_FLAGS = ("-I", "-X", "utf8")
UNSCRUBBED_NAMES = frozenset({"HOME"})


@dataclass(frozen=True, slots=True)
class CappedOutput:
    data: bytes
    exceeded: bool


@dataclass(frozen=True, slots=True)
class HostOutput:
    stdout: CappedOutput
    stderr_tail: bytes
    exit_code: int


def scrubbed_environment(
    parent: Mapping[str, str], dsn: str, statement_timeout_ms: int, workspace: Path
) -> dict[str, str]:
    environment = {
        name: value
        for name, value in parent.items()
        if name.upper() in BASE_VARIABLE_NAMES - UNSCRUBBED_NAMES
    }
    environment["HOME"] = str(workspace)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    environment["PYTHONUTF8"] = "1"
    environment[DSN_VARIABLE] = dsn
    environment[STATEMENT_TIMEOUT_VARIABLE] = str(statement_timeout_ms)
    return environment


async def read_capped(stream: asyncio.StreamReader | None, limit: int) -> CappedOutput:
    if stream is None:
        return CappedOutput(b"", False)
    chunks: list[bytes] = []
    size = 0
    while chunk := await stream.read(READ_CHUNK_BYTES):
        size += len(chunk)
        if size > limit:
            return CappedOutput(b"".join(chunks), True)
        chunks.append(chunk)
    return CappedOutput(b"".join(chunks), False)


async def start_host(workspace: Path, environment: Mapping[str, str]) -> asyncio.subprocess.Process:
    try:
        return await asyncio.create_subprocess_exec(
            sys.executable,
            *ISOLATED_INTERPRETER_FLAGS,
            str(HOST_SCRIPT),
            str(workspace / SOURCE_FILE_NAME),
            cwd=workspace,
            env=dict(environment),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as error:
        raise OracleExecutionError(
            OracleFailureCode.process_failed,
            f"could not start the oracle process: {error.strerror or type(error).__name__}",
        ) from error


async def send_parameters(process: asyncio.subprocess.Process, payload: bytes) -> None:
    stdin = process.stdin
    if stdin is None:
        return
    try:
        stdin.write(payload)
        await stdin.drain()
        stdin.close()
    except (BrokenPipeError, ConnectionResetError):
        return


async def finish_reader(task: asyncio.Task[None]) -> None:
    try:
        await asyncio.wait_for(task, READER_GRACE_SECONDS)
    except TimeoutError:
        task.cancel()


async def converse(
    process: asyncio.subprocess.Process, payload: bytes, timeout_seconds: float
) -> HostOutput:
    stderr_tail = TailBuffer(STDERR_TAIL_BYTES)
    stdout_task = asyncio.create_task(read_capped(process.stdout, STDOUT_LIMIT_BYTES))
    stderr_task = asyncio.create_task(drain(process.stderr, stderr_tail))
    try:
        async with asyncio.timeout(timeout_seconds):
            await send_parameters(process, payload)
            stdout = await stdout_task
            if stdout.exceeded:
                raise OracleExecutionError(
                    OracleFailureCode.output_too_large,
                    f"the oracle wrote more than {STDOUT_LIMIT_BYTES} bytes of rows",
                )
            exit_code = await process.wait()
        await finish_reader(stderr_task)
    except TimeoutError:
        raise OracleExecutionError(
            OracleFailureCode.timeout,
            f"the oracle did not finish within {timeout_seconds:g} seconds and was killed "
            "together with its child processes",
        ) from None
    finally:
        for task in (stdout_task, stderr_task):
            task.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        if process.returncode is None:
            await asyncio.shield(terminate(process))
    return HostOutput(stdout, stderr_tail.snapshot().data, exit_code)


def failure_text(output: HostOutput) -> str:
    detail = output.stderr_tail.decode("utf-8", errors="replace").strip()
    suffix = f": {detail}" if detail else ""
    return f"the oracle process exited with code {output.exit_code}{suffix}"


def parse_host_output(output: HostOutput) -> list[object]:
    try:
        outcome = json.loads(output.stdout.data.decode("utf-8", errors="replace"))
    except ValueError:
        raise OracleExecutionError(OracleFailureCode.process_failed, failure_text(output)) from None
    if not isinstance(outcome, dict):
        raise OracleExecutionError(OracleFailureCode.process_failed, failure_text(output))
    if "error" in outcome:
        raise OracleExecutionError(
            OracleFailureCode.process_failed, f"the oracle failed: {outcome['error']}"
        )
    rows = outcome.get("rows")
    if output.exit_code != 0 or not isinstance(rows, list):
        raise OracleExecutionError(OracleFailureCode.process_failed, failure_text(output))
    return rows


def object_rows(rows: list[object]) -> list[Mapping[str, object]]:
    if not all(isinstance(row, dict) for row in rows):
        raise OracleExecutionError(
            OracleFailureCode.process_failed, "the oracle must return a list of row objects"
        )
    return [row for row in rows if isinstance(row, dict)]


async def run_python_oracle(
    request: OracleRequest, parent_environment: Mapping[str, str] | None = None
) -> OracleExecution:
    parent = os.environ if parent_environment is None else parent_environment
    payload = json.dumps({"params": dict(request.params)}).encode("utf-8")
    timeout_seconds = request.limits.statement_timeout_seconds + PROCESS_START_ALLOWANCE_SECONDS
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="oracle-") as directory:
        workspace = Path(directory)
        (workspace / SOURCE_FILE_NAME).write_text(request.source, encoding="utf-8", newline="\n")
        environment = scrubbed_environment(
            parent, request.dsn, request.limits.statement_timeout_ms, workspace
        )
        process = await start_host(workspace, environment)
        output = await converse(process, payload, timeout_seconds)
    rows, truncated = limit_rows(
        object_rows(parse_host_output(output)),
        request.limits.max_rows,
        request.limits.max_result_bytes,
    )
    return OracleExecution(rows, truncated, round((time.perf_counter() - started) * 1000))
