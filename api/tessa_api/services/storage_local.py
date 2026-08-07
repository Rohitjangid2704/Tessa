import asyncio
import os
import shutil
import time
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Iterator
from datetime import UTC, datetime
from itertools import islice
from pathlib import Path
from stat import S_ISREG

from tessa_api.schemas.storage import StoredObject
from tessa_api.services.artifact_store import CHUNK_BYTES, ByteRange, resolve_byte_range
from tessa_api.services.storage import (
    StorageChunks,
    StorageContent,
    StorageKey,
    StorageKeyError,
    StorageObjectNotFoundError,
    contained,
    storage_key,
)

PARTIAL_SUFFIX = ".partial"
PARTIAL_TOKEN_HEX_DIGITS = 12
REPLACE_ATTEMPTS = 25
REPLACE_RETRY_STEP_SECONDS = 0.05
REPLACE_RETRY_MAX_SECONDS = 0.5
LIST_BATCH_SIZE = 500

WalkedFile = tuple[tuple[str, ...], os.stat_result]


def replace_with_retry(origin: Path, target: Path) -> None:
    for attempt in range(1, REPLACE_ATTEMPTS + 1):
        try:
            origin.replace(target)
            return
        except PermissionError:
            if attempt == REPLACE_ATTEMPTS:
                raise
            time.sleep(min(REPLACE_RETRY_STEP_SECONDS * attempt, REPLACE_RETRY_MAX_SECONDS))


def take[T](iterator: Iterator[T], size: int) -> list[T]:
    return list(islice(iterator, size))


def entry_info(entry: os.DirEntry[str]) -> os.stat_result | None:
    try:
        return entry.stat()
    except OSError:
        return None


def walk_sorted(
    directory: Path, parts: tuple[str, ...], after: tuple[str, ...]
) -> Iterator[WalkedFile]:
    try:
        with os.scandir(directory) as scanner:
            entries = sorted(scanner, key=lambda entry: entry.name)
    except (FileNotFoundError, NotADirectoryError):
        return
    bound = after[0] if after else None
    for entry in entries:
        name = entry.name
        if bound is not None and name < bound:
            continue
        if entry.is_dir(follow_symlinks=False):
            deeper = after[1:] if name == bound else ()
            yield from walk_sorted(Path(entry.path), (*parts, name), deeper)
        elif name != bound and not name.endswith(PARTIAL_SUFFIX) and entry.is_file():
            info = entry_info(entry)
            if info is not None:
                yield (*parts, name), info


def count_objects(directory: Path) -> int:
    return sum(
        1
        for _, _, names in os.walk(directory)
        for name in names
        if not name.endswith(PARTIAL_SUFFIX)
    )


def modified_at_of(info: os.stat_result) -> datetime:
    return datetime.fromtimestamp(info.st_mtime, UTC)


def partial_path_of(path: Path) -> Path:
    token = uuid.uuid4().hex[:PARTIAL_TOKEN_HEX_DIGITS]
    return path.with_name(f".{token}{PARTIAL_SUFFIX}")


class LocalStorage:
    def __init__(self, root: Path) -> None:
        self.root = root

    def path_of(self, key: StorageKey) -> Path:
        validated = storage_key(key)
        return contained(self.root, self.root.joinpath(*validated.split("/")))

    def stored_object(
        self, key: StorageKey, info: os.stat_result, content_type: str | None = None
    ) -> StoredObject:
        return StoredObject(
            key=key,
            size_bytes=info.st_size,
            content_type=content_type,
            modified_at=modified_at_of(info),
        )

    def put_sync(
        self, key: StorageKey, content: StorageContent, content_type: str | None
    ) -> StoredObject:
        path = self.path_of(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = partial_path_of(path)
        try:
            if isinstance(content, bytes):
                partial.write_bytes(content)
            else:
                shutil.copyfile(content, partial)
            info = partial.stat()
            replace_with_retry(partial, path)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        return self.stored_object(key, info, content_type)

    def get_sync(self, key: StorageKey, limit: int | None) -> bytes | None:
        path = self.path_of(key)
        if not path.is_file():
            return None
        try:
            with path.open("rb") as handle:
                return handle.read() if limit is None else handle.read(limit)
        except FileNotFoundError:
            return None

    def stat_sync(self, key: StorageKey) -> StoredObject | None:
        path = self.path_of(key)
        try:
            info = path.stat()
        except (FileNotFoundError, NotADirectoryError):
            return None
        return self.stored_object(key, info) if S_ISREG(info.st_mode) else None

    def delete_sync(self, key: StorageKey) -> None:
        path = self.path_of(key)
        if path.is_file():
            path.unlink(missing_ok=True)

    def delete_prefix_sync(self, prefix: StorageKey) -> int:
        directory = self.path_of(prefix)
        if not directory.is_dir():
            return 0
        removed = count_objects(directory)
        shutil.rmtree(directory, ignore_errors=True)
        return removed

    def move_prefix_sync(self, source: StorageKey, destination: StorageKey) -> int:
        origin = self.path_of(source)
        target = self.path_of(destination)
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink(missing_ok=True)
        if not origin.is_dir():
            return 0
        moved = count_objects(origin)
        target.parent.mkdir(parents=True, exist_ok=True)
        replace_with_retry(origin, target)
        return moved

    def after_parts(
        self, base_parts: tuple[str, ...], start_after: StorageKey | None
    ) -> tuple[str, ...]:
        if start_after is None:
            return ()
        parts = tuple(storage_key(start_after).split("/"))
        if parts[: len(base_parts)] != base_parts or len(parts) == len(base_parts):
            raise StorageKeyError("start_after must be a key below the listed prefix")
        return parts[len(base_parts) :]

    async def put(
        self, key: StorageKey, content: StorageContent, content_type: str | None = None
    ) -> StoredObject:
        return await asyncio.to_thread(self.put_sync, key, content, content_type)

    async def get(self, key: StorageKey, limit: int | None = None) -> bytes | None:
        return await asyncio.to_thread(self.get_sync, key, limit)

    async def stat(self, key: StorageKey) -> StoredObject | None:
        return await asyncio.to_thread(self.stat_sync, key)

    async def exists(self, key: StorageKey) -> bool:
        return await self.stat(key) is not None

    async def open_read(
        self, key: StorageKey, byte_range: ByteRange | None = None
    ) -> StorageChunks:
        stored = await self.stat(key)
        if stored is None:
            raise StorageObjectNotFoundError(key)
        start, end = resolve_byte_range(stored.size_bytes, byte_range)
        return StorageChunks(
            stored=stored,
            start=start,
            end=end,
            chunks=self.read_chunks(self.path_of(key), start, end),
        )

    async def read_chunks(self, path: Path, start: int, end: int) -> AsyncIterator[bytes]:
        remaining = end - start + 1
        handle = await asyncio.to_thread(path.open, "rb")
        try:
            await asyncio.to_thread(handle.seek, start)
            while remaining > 0:
                chunk = await asyncio.to_thread(handle.read, min(CHUNK_BYTES, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
        finally:
            await asyncio.to_thread(handle.close)

    async def delete(self, key: StorageKey) -> None:
        await asyncio.to_thread(self.delete_sync, key)

    async def delete_prefix(self, prefix: StorageKey) -> int:
        return await asyncio.to_thread(self.delete_prefix_sync, prefix)

    async def move_prefix(self, source: StorageKey, destination: StorageKey) -> int:
        return await asyncio.to_thread(self.move_prefix_sync, source, destination)

    async def list_prefix(
        self, prefix: StorageKey, start_after: StorageKey | None = None
    ) -> AsyncGenerator[StoredObject]:
        base_parts = tuple(storage_key(prefix).split("/"))
        walker = walk_sorted(self.path_of(prefix), (), self.after_parts(base_parts, start_after))
        while True:
            batch = await asyncio.to_thread(take, walker, LIST_BATCH_SIZE)
            if not batch:
                return
            for parts, info in batch:
                yield self.stored_object(StorageKey("/".join((*base_parts, *parts))), info)
