import asyncio
import hashlib
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Mapping
from contextlib import suppress
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import NewType, Protocol

from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.storage import StorageSettings, StoredObject
from tessa_api.services.artifact_store import ByteRange
from tessa_api.settings import StrictSettings

BUNDLES_FOLDER = "bundles"
STAGING_PREFIX = ".staging-"
STAGE_CONCURRENCY = 8
STORAGE_KEY_MAX_LENGTH = 1024
STORAGE_KEY_FORBIDDEN_SEGMENTS = frozenset({"", ".", ".."})
STORAGE_KEY_FORBIDDEN_CHARACTERS = frozenset({"\\", ":"})
STORAGE_UNAVAILABLE_MESSAGE = "Object storage is unavailable"

StorageKey = NewType("StorageKey", str)
StorageContent = bytes | Path


class StorageError(Exception):
    pass


class StorageKeyError(StorageError, ValueError):
    pass


class StorageObjectNotFoundError(StorageError):
    def __init__(self, key: StorageKey) -> None:
        super().__init__(f"nothing is stored under {key}")
        self.key = key


class StorageUnavailableError(StorageError, ApiError):
    def __init__(self, message: str = STORAGE_UNAVAILABLE_MESSAGE) -> None:
        detail = ErrorDetail(loc=["dependency"], code="storage", message=message)
        ApiError.__init__(self, 503, "dependency_unavailable", message, [detail])


@dataclass(frozen=True, slots=True)
class StorageChunks:
    stored: StoredObject
    start: int
    end: int
    chunks: AsyncIterator[bytes]

    @property
    def length(self) -> int:
        return self.end - self.start + 1


class Storage(Protocol):
    async def put(
        self, key: StorageKey, content: StorageContent, content_type: str | None = None
    ) -> StoredObject: ...

    async def get(self, key: StorageKey, limit: int | None = None) -> bytes | None: ...

    async def stat(self, key: StorageKey) -> StoredObject | None: ...

    async def exists(self, key: StorageKey) -> bool: ...

    async def open_read(
        self, key: StorageKey, byte_range: ByteRange | None = None
    ) -> StorageChunks: ...

    async def delete(self, key: StorageKey) -> None: ...

    async def delete_prefix(self, prefix: StorageKey) -> int: ...

    async def move_prefix(self, source: StorageKey, destination: StorageKey) -> int: ...

    def list_prefix(
        self, prefix: StorageKey, start_after: StorageKey | None = None
    ) -> AsyncGenerator[StoredObject]: ...


def is_forbidden_key_character(character: str) -> bool:
    return ord(character) < 32 or character in STORAGE_KEY_FORBIDDEN_CHARACTERS


def storage_key(*segments: str) -> StorageKey:
    key = "/".join(segment.strip("/") for segment in segments)
    if len(key) > STORAGE_KEY_MAX_LENGTH:
        raise StorageKeyError(f"a storage key is at most {STORAGE_KEY_MAX_LENGTH} characters")
    for part in key.split("/"):
        if part in STORAGE_KEY_FORBIDDEN_SEGMENTS:
            raise StorageKeyError(f"{key!r} has an empty, . or .. segment")
        if any(is_forbidden_key_character(character) for character in part):
            raise StorageKeyError(f"{key!r} has a control character, backslash or colon")
    return StorageKey(key)


def storage_settings_of(settings: StrictSettings) -> StorageSettings:
    return StorageSettings(data_dir=settings.data_dir)


def build_storage(settings: StorageSettings) -> Storage:
    from tessa_api.services.storage_local import LocalStorage

    return LocalStorage(settings.data_dir)


@cache
def shared_storage(settings: StorageSettings) -> Storage:
    return build_storage(settings)


def storage_from_settings(settings: StrictSettings) -> Storage:
    return shared_storage(storage_settings_of(settings))


@dataclass(frozen=True)
class StagedBundle:
    target_id: uuid.UUID
    location: str


class BundleStore(Protocol):
    async def stage(self, target_id: uuid.UUID, files: Mapping[str, bytes]) -> StagedBundle: ...

    async def commit(self, staged: StagedBundle, version: int) -> str: ...

    async def discard(self, staged: StagedBundle) -> None: ...

    async def remove(self, storage_path: str) -> None: ...

    async def read(self, storage_path: str, path: str, limit: int) -> bytes | None: ...


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


EXTENDED_LENGTH_PREFIX = "\\\\?\\"
EXTENDED_UNC_PREFIX = "\\\\?\\UNC\\"


def without_extended_prefix(path: Path) -> Path:
    text = str(path)
    if text.startswith(EXTENDED_UNC_PREFIX):
        return Path("\\\\" + text[len(EXTENDED_UNC_PREFIX) :])
    if text.startswith(EXTENDED_LENGTH_PREFIX):
        return Path(text[len(EXTENDED_LENGTH_PREFIX) :])
    return path


def contained(root: Path, candidate: Path) -> Path:
    resolved = without_extended_prefix(candidate.resolve())
    if not resolved.is_relative_to(without_extended_prefix(root.resolve())):
        raise ValueError(f"{candidate} is outside {root}")
    return resolved


class StorageBundleStore:
    def __init__(self, storage: Storage) -> None:
        self.storage = storage

    async def put_files(self, prefix: StorageKey, files: Mapping[str, bytes]) -> None:
        gate = asyncio.Semaphore(STAGE_CONCURRENCY)

        async def put_one(path: str, content: bytes) -> None:
            async with gate:
                await self.storage.put(storage_key(prefix, path), content)

        outcomes = await asyncio.gather(
            *(put_one(path, content) for path, content in files.items()), return_exceptions=True
        )
        for outcome in outcomes:
            if isinstance(outcome, BaseException):
                raise outcome

    async def stage(self, target_id: uuid.UUID, files: Mapping[str, bytes]) -> StagedBundle:
        prefix = storage_key(BUNDLES_FOLDER, str(target_id), f"{STAGING_PREFIX}{uuid.uuid4().hex}")
        try:
            await self.put_files(prefix, files)
        except BaseException:
            with suppress(StorageError):
                await self.storage.delete_prefix(prefix)
            raise
        return StagedBundle(target_id=target_id, location=prefix)

    async def commit(self, staged: StagedBundle, version: int) -> str:
        destination = storage_key(BUNDLES_FOLDER, str(staged.target_id), str(version))
        await self.storage.move_prefix(StorageKey(staged.location), destination)
        return destination

    async def discard(self, staged: StagedBundle) -> None:
        await self.storage.delete_prefix(StorageKey(staged.location))

    async def remove(self, storage_path: str) -> None:
        await self.storage.delete_prefix(storage_key(storage_path))

    async def read(self, storage_path: str, path: str, limit: int) -> bytes | None:
        try:
            key = storage_key(storage_path, path)
        except StorageKeyError:
            return None
        return await self.storage.get(key, limit)


class LocalBundleStore(StorageBundleStore):
    def __init__(self, data_dir: Path) -> None:
        from tessa_api.services.storage_local import LocalStorage

        super().__init__(LocalStorage(data_dir))


def bundle_store_from_settings(settings: StrictSettings) -> BundleStore:
    return StorageBundleStore(storage_from_settings(settings))
