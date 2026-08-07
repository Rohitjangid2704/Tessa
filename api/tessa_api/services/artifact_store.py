from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID

from tessa_api.schemas.artifacts import StoredArtifact
from tessa_api.schemas.enums import ArtifactKind

ARTIFACTS_DIRECTORY_NAME = "artifacts"
SHARD_HEX_DIGITS = 6
CHUNK_BYTES = 64 * 1024

ArtifactContent = bytes | Path


class ArtifactNotFoundError(Exception):
    def __init__(self, artifact_id: UUID) -> None:
        super().__init__(f"artifact {artifact_id} is not stored")
        self.artifact_id = artifact_id


class RangeNotSatisfiableError(Exception):
    def __init__(self, size_bytes: int) -> None:
        super().__init__(f"range outside an artifact of {size_bytes} bytes")
        self.size_bytes = size_bytes


@dataclass(frozen=True, slots=True)
class ByteRange:
    start: int
    end: int | None


@dataclass(frozen=True, slots=True)
class ArtifactChunks:
    artifact: StoredArtifact
    start: int
    end: int
    chunks: AsyncIterator[bytes]

    @property
    def length(self) -> int:
        return self.end - self.start + 1


class ArtifactStore(Protocol):
    async def put(
        self, artifact_id: UUID, content: ArtifactContent, kind: ArtifactKind, mime: str
    ) -> StoredArtifact: ...

    async def info(self, artifact_id: UUID) -> StoredArtifact: ...

    async def size(self, artifact_id: UUID) -> int: ...

    async def open(
        self, artifact_id: UUID, byte_range: ByteRange | None = None
    ) -> ArtifactChunks: ...

    async def delete(self, artifact_id: UUID) -> None: ...


def artifact_relative_path(artifact_id: UUID) -> str:
    digits = artifact_id.hex
    return f"{ARTIFACTS_DIRECTORY_NAME}/{digits[:SHARD_HEX_DIGITS]}/{digits}"


def resolve_byte_range(size_bytes: int, byte_range: ByteRange | None) -> tuple[int, int]:
    if byte_range is None:
        return 0, size_bytes - 1
    if byte_range.start < 0 or byte_range.start >= size_bytes:
        raise RangeNotSatisfiableError(size_bytes)
    last = size_bytes - 1 if byte_range.end is None else min(byte_range.end, size_bytes - 1)
    if last < byte_range.start:
        raise RangeNotSatisfiableError(size_bytes)
    return byte_range.start, last


async def iterate_chunks(data: bytes, start: int, end: int) -> AsyncIterator[bytes]:
    for offset in range(start, end + 1, CHUNK_BYTES):
        yield data[offset : min(offset + CHUNK_BYTES, end + 1)]


class InMemoryArtifactStore:
    def __init__(self) -> None:
        self.entries: dict[UUID, tuple[StoredArtifact, bytes]] = {}

    async def put(
        self, artifact_id: UUID, content: ArtifactContent, kind: ArtifactKind, mime: str
    ) -> StoredArtifact:
        data = content if isinstance(content, bytes) else content.read_bytes()
        stored = StoredArtifact(id=artifact_id, kind=kind, mime=mime, size_bytes=len(data))
        self.entries[artifact_id] = (stored, data)
        return stored

    async def info(self, artifact_id: UUID) -> StoredArtifact:
        return self.entry(artifact_id)[0]

    async def size(self, artifact_id: UUID) -> int:
        return self.entry(artifact_id)[0].size_bytes

    async def open(self, artifact_id: UUID, byte_range: ByteRange | None = None) -> ArtifactChunks:
        stored, data = self.entry(artifact_id)
        start, end = resolve_byte_range(stored.size_bytes, byte_range)
        return ArtifactChunks(
            artifact=stored, start=start, end=end, chunks=iterate_chunks(data, start, end)
        )

    async def delete(self, artifact_id: UUID) -> None:
        self.entries.pop(artifact_id, None)

    def entry(self, artifact_id: UUID) -> tuple[StoredArtifact, bytes]:
        try:
            return self.entries[artifact_id]
        except KeyError:
            raise ArtifactNotFoundError(artifact_id) from None
