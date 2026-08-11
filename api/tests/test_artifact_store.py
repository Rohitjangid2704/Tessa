import uuid
from pathlib import Path, PurePosixPath

import pytest

from tessa_api.ids import new_id
from tessa_api.schemas.enums import ArtifactKind
from tessa_api.services.artifact_store import (
    CHUNK_BYTES,
    ArtifactChunks,
    ArtifactNotFoundError,
    ArtifactStore,
    ByteRange,
    InMemoryArtifactStore,
    RangeNotSatisfiableError,
    artifact_relative_path,
    resolve_byte_range,
)

PAYLOAD = bytes(range(256)) * 10


async def read_all(chunks: ArtifactChunks) -> bytes:
    return b"".join([chunk async for chunk in chunks.chunks])


def make_store() -> ArtifactStore:
    return InMemoryArtifactStore()


async def test_put_returns_what_info_and_size_report() -> None:
    store = make_store()
    artifact_id = new_id()
    stored = await store.put(artifact_id, PAYLOAD, ArtifactKind.screenshot, "image/png")
    assert stored.id == artifact_id
    assert (stored.kind, stored.mime, stored.size_bytes) == (
        ArtifactKind.screenshot,
        "image/png",
        len(PAYLOAD),
    )
    assert await store.info(artifact_id) == stored
    assert await store.size(artifact_id) == len(PAYLOAD)


@pytest.fixture
def source_file(tmp_path: Path) -> Path:
    path = tmp_path / "trace.zip"
    path.write_bytes(PAYLOAD)
    return path


async def test_put_accepts_a_file_and_overwrites_the_same_id(source_file: Path) -> None:
    store = make_store()
    artifact_id = new_id()
    await store.put(artifact_id, b"first", ArtifactKind.trace, "application/zip")
    stored = await store.put(artifact_id, source_file, ArtifactKind.trace, "application/zip")
    assert stored.size_bytes == len(PAYLOAD)
    assert await read_all(await store.open(artifact_id)) == PAYLOAD


async def test_open_without_a_range_streams_the_whole_file_in_chunks() -> None:
    store = make_store()
    artifact_id = new_id()
    big = b"x" * (CHUNK_BYTES * 2 + 17)
    await store.put(artifact_id, big, ArtifactKind.recording, "video/webm")
    opened = await store.open(artifact_id)
    assert (opened.start, opened.end, opened.length) == (0, len(big) - 1, len(big))
    chunks = [chunk async for chunk in opened.chunks]
    assert [len(chunk) for chunk in chunks] == [CHUNK_BYTES, CHUNK_BYTES, 17]
    assert b"".join(chunks) == big


@pytest.mark.parametrize(
    ("byte_range", "start", "end"),
    [
        (ByteRange(0, 9), 0, 9),
        (ByteRange(100, 199), 100, 199),
        (ByteRange(2550, None), 2550, 2559),
        (ByteRange(2550, 99999), 2550, 2559),
        (ByteRange(2559, 2559), 2559, 2559),
    ],
)
async def test_open_serves_the_requested_byte_range(
    byte_range: ByteRange, start: int, end: int
) -> None:
    store = make_store()
    artifact_id = new_id()
    await store.put(artifact_id, PAYLOAD, ArtifactKind.recording, "video/webm")
    opened = await store.open(artifact_id, byte_range)
    assert (opened.start, opened.end) == (start, end)
    assert opened.length == end - start + 1
    assert opened.artifact.size_bytes == len(PAYLOAD)
    assert await read_all(opened) == PAYLOAD[start : end + 1]


@pytest.mark.parametrize(
    "byte_range", [ByteRange(2560, None), ByteRange(5000, 6000), ByteRange(-1, 5), ByteRange(9, 3)]
)
async def test_an_unsatisfiable_range_is_reported(byte_range: ByteRange) -> None:
    store = make_store()
    artifact_id = new_id()
    await store.put(artifact_id, PAYLOAD, ArtifactKind.recording, "video/webm")
    with pytest.raises(RangeNotSatisfiableError) as caught:
        await store.open(artifact_id, byte_range)
    assert caught.value.size_bytes == len(PAYLOAD)


async def test_an_empty_artifact_streams_nothing_and_has_no_satisfiable_range() -> None:
    store = make_store()
    artifact_id = new_id()
    await store.put(artifact_id, b"", ArtifactKind.report_json, "application/json")
    opened = await store.open(artifact_id)
    assert opened.length == 0
    assert await read_all(opened) == b""
    with pytest.raises(RangeNotSatisfiableError):
        await store.open(artifact_id, ByteRange(0, None))


async def test_a_missing_artifact_is_not_found_everywhere() -> None:
    store = make_store()
    missing = uuid.uuid4()
    with pytest.raises(ArtifactNotFoundError):
        await store.info(missing)
    with pytest.raises(ArtifactNotFoundError):
        await store.size(missing)
    with pytest.raises(ArtifactNotFoundError):
        await store.open(missing)


async def test_delete_removes_the_artifact_and_is_safe_to_repeat() -> None:
    store = make_store()
    artifact_id = new_id()
    await store.put(artifact_id, b"data", ArtifactKind.screenshot, "image/png")
    await store.delete(artifact_id)
    await store.delete(artifact_id)
    with pytest.raises(ArtifactNotFoundError):
        await store.info(artifact_id)


def test_resolve_byte_range_without_a_range_covers_the_file() -> None:
    assert resolve_byte_range(10, None) == (0, 9)
    assert resolve_byte_range(0, None) == (0, -1)


def test_the_relative_path_is_built_from_the_id_only_and_stays_short() -> None:
    artifact_id = uuid.UUID("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11")
    relative = artifact_relative_path(artifact_id)
    assert relative == "artifacts/0198f6/0198f6f24c2a7d109c1e6a4f0d3b8e11"
    assert len(relative) < 50
    parts = PurePosixPath(relative).parts
    assert parts[0] == "artifacts"
    assert parts[2].startswith(parts[1])
    assert all(character.isalnum() or character == "/" for character in relative)


def test_ids_made_close_in_time_share_a_shard_and_distinct_ids_never_share_a_path() -> None:
    first, second = new_id(), new_id()
    assert artifact_relative_path(first) != artifact_relative_path(second)
    assert (
        artifact_relative_path(first).split("/")[1] == artifact_relative_path(second).split("/")[1]
    )
