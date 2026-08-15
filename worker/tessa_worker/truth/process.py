import asyncio
import contextlib
import logging
from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import psutil

from tessa_worker.truth.errors import SeedFailure, SeedFailureCode

READ_CHUNK_BYTES = 65536
KILL_PASSES = 5
KILL_WAIT_SECONDS = 3.0
READER_GRACE_SECONDS = 2.0

logger = logging.getLogger("tessa_worker.truth")


@dataclass(frozen=True, slots=True)
class TailSnapshot:
    data: bytes
    truncated: bool


class TailBuffer:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.chunks: deque[bytes] = deque()
        self.size = 0
        self.dropped = False

    def append(self, chunk: bytes) -> None:
        self.chunks.append(chunk)
        self.size += len(chunk)
        while len(self.chunks) > 1 and self.size - len(self.chunks[0]) >= self.limit:
            self.size -= len(self.chunks.popleft())
            self.dropped = True

    def snapshot(self) -> TailSnapshot:
        data = b"".join(self.chunks)
        return TailSnapshot(data[-self.limit :], self.dropped or len(data) > self.limit)


@dataclass(frozen=True, slots=True)
class ProcessResult:
    exit_code: int
    stdout: TailSnapshot
    stderr: TailSnapshot


async def drain(stream: asyncio.StreamReader | None, tail: TailBuffer) -> None:
    if stream is None:
        return
    while chunk := await stream.read(READ_CHUNK_BYTES):
        tail.append(chunk)


def process_family(root: psutil.Process) -> list[psutil.Process]:
    try:
        return [root, *root.children(recursive=True)]
    except psutil.NoSuchProcess:
        return []


def apply_to_each(members: Sequence[psutil.Process], action: str) -> None:
    for member in members:
        try:
            getattr(member, action)()
        except psutil.NoSuchProcess:
            continue
        except psutil.Error as error:
            logger.warning(
                "seed_process_not_stopped",
                extra={"pid": member.pid, "action": action, "error": type(error).__name__},
            )


def merged_family(
    first: Sequence[psutil.Process], second: Sequence[psutil.Process]
) -> list[psutil.Process]:
    return list({member.pid: member for member in [*first, *second]}.values())


def kill_process_tree(pid: int) -> None:
    try:
        root = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return
    for _ in range(KILL_PASSES):
        family = process_family(root)
        if not family:
            return
        apply_to_each(family, "suspend")
        family = merged_family(family, process_family(root))
        apply_to_each(family, "kill")
        psutil.wait_procs(family, timeout=KILL_WAIT_SECONDS)


async def terminate(process: asyncio.subprocess.Process) -> None:
    await asyncio.to_thread(kill_process_tree, process.pid)
    with contextlib.suppress(ProcessLookupError, PermissionError):
        process.kill()
    await process.wait()


async def settle_readers(readers: Sequence[asyncio.Task[None]]) -> None:
    if readers:
        await asyncio.wait(readers, timeout=READER_GRACE_SECONDS)


async def stop_readers(readers: Sequence[asyncio.Task[None]]) -> None:
    for reader in readers:
        reader.cancel()
    await asyncio.gather(*readers, return_exceptions=True)


async def start_process(
    arguments: Sequence[str],
    working_directory: Path,
    environment: Mapping[str, str],
    merge_stderr: bool,
) -> asyncio.subprocess.Process:
    try:
        return await asyncio.create_subprocess_exec(
            *arguments,
            cwd=working_directory,
            env=dict(environment),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT if merge_stderr else asyncio.subprocess.PIPE,
        )
    except OSError as error:
        raise SeedFailure(
            SeedFailureCode.spawn_failed,
            f"could not start {arguments[0]!r}: {error.strerror or type(error).__name__}",
        ) from error


async def run_process(
    arguments: Sequence[str],
    working_directory: Path,
    environment: Mapping[str, str],
    timeout_seconds: float,
    tail_bytes: int,
    merge_stderr: bool,
) -> ProcessResult:
    process = await start_process(arguments, working_directory, environment, merge_stderr)
    stdout_tail = TailBuffer(tail_bytes)
    stderr_tail = TailBuffer(tail_bytes)
    readers = [asyncio.create_task(drain(process.stdout, stdout_tail))]
    if not merge_stderr:
        readers.append(asyncio.create_task(drain(process.stderr, stderr_tail)))
    try:
        try:
            async with asyncio.timeout(timeout_seconds):
                exit_code = await process.wait()
        except TimeoutError:
            await terminate(process)
            raise SeedFailure(
                SeedFailureCode.timeout,
                f"the process did not finish within {timeout_seconds:g} seconds and was killed "
                "together with its child processes",
            ) from None
        except asyncio.CancelledError:
            await asyncio.shield(terminate(process))
            raise
        await settle_readers(readers)
    finally:
        await stop_readers(readers)
    return ProcessResult(exit_code, stdout_tail.snapshot(), stderr_tail.snapshot())
