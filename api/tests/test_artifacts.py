import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
import pytest
from pydantic import SecretStr

from tessa_api.schemas.artifacts import StoredArtifact
from tessa_api.schemas.enums import ArtifactKind
from tessa_api.services.artifact_store import (
    ArtifactNotFoundError,
    ByteRange,
    RangeNotSatisfiableError,
    artifact_relative_path,
)
from tessa_api.services.artifacts import (
    ARTIFACT_URL_PREFIX,
    ArtifactSigner,
    ExpiredArtifactTokenError,
    InvalidArtifactTokenError,
    LocalArtifactStore,
    SuffixRange,
    artifact_references,
    content_disposition,
    parse_range_header,
    resolve_requested_range,
)

KEY = SecretStr("dev-only-test-ws-ticket-signing-key-0123456")
OTHER_KEY = SecretStr("dev-only-another-signing-key-0123456789-x")
NOW = datetime(2026, 10, 5, 12, 0, 0, tzinfo=UTC)
ARTIFACT_ID = uuid.UUID("0198f6f2-7b00-7a00-9d00-000000000001")


def signer(ttl: int = 900, key: SecretStr = KEY) -> ArtifactSigner:
    return ArtifactSigner(key, ttl)


def stored(kind: ArtifactKind = ArtifactKind.screenshot, mime: str = "image/png") -> StoredArtifact:
    return StoredArtifact(id=ARTIFACT_ID, kind=kind, mime=mime, size_bytes=12)


def test_a_signed_token_verifies_until_its_expiry_and_not_after() -> None:
    token, expires_at = signer(60).sign(ARTIFACT_ID, issued_at=NOW)
    assert expires_at == NOW + timedelta(seconds=60)
    link = signer(60).verify(token, now=NOW)
    assert link.artifact_id == ARTIFACT_ID
    assert link.expires_at == expires_at
    assert signer(60).verify(token, now=NOW + timedelta(seconds=59)).artifact_id == ARTIFACT_ID
    with pytest.raises(ExpiredArtifactTokenError):
        signer(60).verify(token, now=NOW + timedelta(seconds=60))
    with pytest.raises(ExpiredArtifactTokenError):
        signer(60).verify(token, now=NOW + timedelta(days=1))


def test_the_default_clock_is_the_real_one() -> None:
    token, _ = signer(900).sign(ARTIFACT_ID)
    assert signer(900).verify(token).artifact_id == ARTIFACT_ID
    expired, _ = signer(900).sign(ARTIFACT_ID, issued_at=datetime.now(UTC) - timedelta(hours=1))
    with pytest.raises(ExpiredArtifactTokenError):
        signer(900).verify(expired)


def test_any_change_to_the_token_is_rejected() -> None:
    token, _ = signer().sign(ARTIFACT_ID, issued_at=NOW)
    artifact_hex, expiry, signature = token.split(".")
    other_id = uuid.UUID("0198f6f2-7b00-7a00-9d00-000000000002").hex
    forged = [
        ".".join((other_id, expiry, signature)),
        ".".join((artifact_hex, str(int(expiry) + 3600), signature)),
        ".".join(
            (artifact_hex, expiry, signature[:-2] + ("AA" if signature[-2:] != "AA" else "BB"))
        ),
        ".".join((artifact_hex, expiry, "")),
        ".".join((artifact_hex, expiry, signature, "extra")),
        token.upper() if token.upper() != token else token + "x",
        "",
        "...",
        "not-a-token",
        ".".join((artifact_hex, "soon", signature)),
        ".".join(("zz" * 16, expiry, signature)),
        ".".join((artifact_hex, expiry, "é" * 43)),
    ]
    for candidate in forged:
        with pytest.raises(InvalidArtifactTokenError):
            signer().verify(candidate, now=NOW)


def test_a_token_signed_with_another_key_is_rejected() -> None:
    token, _ = signer(key=OTHER_KEY).sign(ARTIFACT_ID, issued_at=NOW)
    with pytest.raises(InvalidArtifactTokenError):
        signer().verify(token, now=NOW)


def test_a_websocket_ticket_cannot_be_replayed_as_an_artifact_token() -> None:
    ticket = jwt.encode(
        {"typ": "ws-ticket", "sub": "u", "run_id": str(ARTIFACT_ID)},
        KEY.get_secret_value(),
        algorithm="HS256",
    )
    with pytest.raises(InvalidArtifactTokenError):
        signer().verify(ticket, now=NOW)


def test_signing_is_stable_for_one_artifact_and_different_between_artifacts() -> None:
    first, _ = signer().sign(ARTIFACT_ID, issued_at=NOW)
    again, _ = signer().sign(ARTIFACT_ID, issued_at=NOW)
    other, _ = signer().sign(uuid.UUID(int=ARTIFACT_ID.int + 1), issued_at=NOW)
    assert first == again
    assert first != other
    assert "=" not in first
    assert len(first) < 120


def test_a_reference_carries_the_signed_relative_url_and_its_expiry() -> None:
    reference = signer(120).reference(stored(), issued_at=NOW)
    assert reference.id == ARTIFACT_ID
    assert reference.kind is ArtifactKind.screenshot
    assert reference.mime == "image/png"
    assert reference.size_bytes == 12
    assert reference.url.startswith(ARTIFACT_URL_PREFIX)
    assert reference.expires_at == NOW + timedelta(seconds=120)
    token = reference.url.removeprefix(ARTIFACT_URL_PREFIX)
    assert signer(120).verify(token, now=NOW).artifact_id == ARTIFACT_ID
    refs = artifact_references(signer(), [stored().model_dump(mode="json")], NOW)
    assert [ref.id for ref in refs] == [ARTIFACT_ID]


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (None, None),
        ("", None),
        ("items=0-1", None),
        ("bytes=0-99", ByteRange(0, 99)),
        ("bytes=10-", ByteRange(10, None)),
        ("BYTES=10-20", ByteRange(10, 20)),
        ("bytes=-500", SuffixRange(500)),
        ("bytes=0-0", ByteRange(0, 0)),
        ("bytes=9-2", None),
        ("bytes=a-b", None),
        ("bytes=0-1,5-6", None),
        ("bytes=5", None),
        ("bytes=-", None),
        ("bytes=-x", None),
    ],
)
def test_range_headers_are_parsed_or_ignored(header: str | None, expected: object) -> None:
    assert parse_range_header(header) == expected


def test_a_suffix_range_resolves_against_the_file_size() -> None:
    assert resolve_requested_range(SuffixRange(4), 10) == ByteRange(6, None)
    assert resolve_requested_range(SuffixRange(40), 10) == ByteRange(0, None)
    assert resolve_requested_range(SuffixRange(0), 10) == ByteRange(10, None)
    assert resolve_requested_range(ByteRange(1, 2), 10) == ByteRange(1, 2)
    assert resolve_requested_range(None, 10) is None


@pytest.mark.parametrize(
    ("mime", "kind", "disposition", "extension"),
    [
        ("image/png", ArtifactKind.screenshot, "inline", "png"),
        ("video/webm", ArtifactKind.recording, "inline", "webm"),
        ("application/zip", ArtifactKind.trace, "attachment", "zip"),
        ("application/octet-stream", ArtifactKind.report_json, "attachment", "bin"),
    ],
)
def test_content_disposition_names_the_file_from_the_kind_and_id(
    mime: str, kind: ArtifactKind, disposition: str, extension: str
) -> None:
    header = content_disposition(stored(kind, mime))
    assert header == f'{disposition}; filename="{kind.value}-{ARTIFACT_ID.hex[:12]}.{extension}"'


async def collect(chunks: AsyncIterator[bytes]) -> bytes:
    data = b""
    async for chunk in chunks:
        data += chunk
    return data


async def test_the_local_store_keeps_files_by_id_and_serves_exact_ranges(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path)
    payload = bytes(range(256)) * 1024
    result = await store.put(ARTIFACT_ID, payload, ArtifactKind.recording, "video/webm")
    assert result == StoredArtifact(
        id=ARTIFACT_ID, kind=ArtifactKind.recording, mime="video/webm", size_bytes=len(payload)
    )
    assert (tmp_path / artifact_relative_path(ARTIFACT_ID)).read_bytes() == payload
    assert await store.info(ARTIFACT_ID) == result
    assert await store.size(ARTIFACT_ID) == len(payload)
    full = await store.open(ARTIFACT_ID)
    assert (full.start, full.end, full.length) == (0, len(payload) - 1, len(payload))
    assert await collect(full.chunks) == payload
    ranged = await store.open(ARTIFACT_ID, ByteRange(70_000, 70_099))
    assert ranged.length == 100
    assert await collect(ranged.chunks) == payload[70_000:70_100]
    tail = await store.open(ARTIFACT_ID, ByteRange(len(payload) - 3, None))
    assert await collect(tail.chunks) == payload[-3:]
    clamped = await store.open(ARTIFACT_ID, ByteRange(5, 10**9))
    assert await collect(clamped.chunks) == payload[5:]
    across = await store.open(ARTIFACT_ID, ByteRange(65_530, 65_545))
    assert await collect(across.chunks) == payload[65_530:65_546]


async def test_a_range_outside_the_file_is_not_satisfiable(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path)
    await store.put(ARTIFACT_ID, b"0123456789", ArtifactKind.screenshot, "image/png")
    for byte_range in (ByteRange(10, None), ByteRange(11, 20), ByteRange(-1, 4)):
        with pytest.raises(RangeNotSatisfiableError) as raised:
            await store.open(ARTIFACT_ID, byte_range)
        assert raised.value.size_bytes == 10


async def test_a_missing_artifact_is_reported_and_delete_is_idempotent(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path)
    for call in (store.info, store.size, store.open):
        with pytest.raises(ArtifactNotFoundError):
            await call(ARTIFACT_ID)
    await store.put(ARTIFACT_ID, b"x", ArtifactKind.trace, "application/zip")
    await store.delete(ARTIFACT_ID)
    await store.delete(ARTIFACT_ID)
    with pytest.raises(ArtifactNotFoundError):
        await store.info(ARTIFACT_ID)
    assert not (tmp_path / artifact_relative_path(ARTIFACT_ID)).exists()


async def test_a_path_source_is_copied_and_a_failed_copy_leaves_nothing(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path / "data")
    source = tmp_path / "recording.webm"
    source.write_bytes(b"webm-bytes")
    await store.put(ARTIFACT_ID, source, ArtifactKind.recording, "video/webm")
    source.unlink()
    assert await collect((await store.open(ARTIFACT_ID)).chunks) == b"webm-bytes"
    other = uuid.UUID(int=ARTIFACT_ID.int + 7)
    with pytest.raises(FileNotFoundError):
        await store.put(other, tmp_path / "missing.webm", ArtifactKind.recording, "video/webm")
    shard = (tmp_path / "data" / artifact_relative_path(other)).parent
    assert [path.name for path in shard.iterdir() if path.name.startswith(other.hex)] == []
    with pytest.raises(ArtifactNotFoundError):
        await store.info(other)


async def test_overwriting_an_artifact_replaces_content_and_size(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path)
    await store.put(ARTIFACT_ID, b"first", ArtifactKind.screenshot, "image/png")
    second = await store.put(ARTIFACT_ID, b"second one", ArtifactKind.screenshot, "image/png")
    assert second.size_bytes == 10
    assert await collect((await store.open(ARTIFACT_ID)).chunks) == b"second one"


def test_the_stored_path_is_derived_from_the_id_only() -> None:
    path = artifact_relative_path(ARTIFACT_ID)
    assert path == f"artifacts/{ARTIFACT_ID.hex[:6]}/{ARTIFACT_ID.hex}"
    assert len(path) < 60
