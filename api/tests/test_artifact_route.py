import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from tessa_api.schemas.enums import ArtifactKind
from tessa_api.services.artifact_store import InMemoryArtifactStore
from tessa_api.services.artifacts import (
    ARTIFACT_URL_PREFIX,
    ArtifactSigner,
    LocalArtifactStore,
    artifact_signer_from_settings,
)
from tessa_api.settings import Settings
from tests.support import settings_with

WEBM = bytes(range(256)) * 900
PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(200))
ZIP = b"PK\x03\x04" + b"z" * 5000


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return settings_with(data_dir=tmp_path / "data")


@pytest.fixture
def signer(settings: Settings) -> ArtifactSigner:
    return artifact_signer_from_settings(settings)


@pytest.fixture(params=["local", "memory"])
async def store(request: pytest.FixtureRequest, app: FastAPI, settings: Settings) -> Any:
    chosen: Any = (
        LocalArtifactStore(settings.data_dir)
        if request.param == "local"
        else InMemoryArtifactStore()
    )
    app.state.artifact_store = chosen
    return chosen


async def add(store: Any, content: bytes, kind: ArtifactKind, mime: str) -> uuid.UUID:
    artifact_id = uuid.uuid4()
    await store.put(artifact_id, content, kind, mime)
    return artifact_id


def url_for(
    signer: ArtifactSigner, artifact_id: uuid.UUID, issued_at: datetime | None = None
) -> str:
    token, _ = signer.sign(artifact_id, issued_at)
    return f"{ARTIFACT_URL_PREFIX}{token}"


async def test_a_signed_url_serves_the_whole_file_without_a_bearer_token(
    client: httpx.AsyncClient, store: Any, signer: ArtifactSigner
) -> None:
    artifact_id = await add(store, PNG, ArtifactKind.screenshot, "image/png")
    response = await client.get(url_for(signer, artifact_id))
    assert response.status_code == 200
    assert response.content == PNG
    assert response.headers["content-type"] == "image/png"
    assert response.headers["content-length"] == str(len(PNG))
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-disposition"] == (
        f'inline; filename="screenshot-{artifact_id.hex[:12]}.png"'
    )
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "content-range" not in response.headers


@pytest.mark.parametrize(
    ("kind", "mime", "content", "disposition"),
    [
        (ArtifactKind.recording, "video/webm", WEBM, "inline"),
        (ArtifactKind.trace, "application/zip", ZIP, "attachment"),
    ],
    ids=["recording", "trace"],
)
async def test_every_artifact_kind_streams_with_its_media_type(
    client: httpx.AsyncClient,
    store: Any,
    signer: ArtifactSigner,
    kind: ArtifactKind,
    mime: str,
    content: bytes,
    disposition: str,
) -> None:
    artifact_id = await add(store, content, kind, mime)
    response = await client.get(url_for(signer, artifact_id))
    assert response.status_code == 200
    assert response.content == content
    assert response.headers["content-type"] == mime
    assert response.headers["content-disposition"].startswith(f"{disposition};")


@pytest.mark.parametrize(
    ("header", "start", "end"),
    [
        ("bytes=0-9", 0, 9),
        ("bytes=100-199", 100, 199),
        ("bytes=65530-65545", 65530, 65545),
        ("bytes=230000-", 230000, len(WEBM) - 1),
        ("bytes=-1000", len(WEBM) - 1000, len(WEBM) - 1),
        ("bytes=0-99999999", 0, len(WEBM) - 1),
        ("bytes=0-0", 0, 0),
    ],
)
async def test_a_range_request_gets_206_with_exactly_the_requested_bytes(
    client: httpx.AsyncClient, store: Any, signer: ArtifactSigner, header: str, start: int, end: int
) -> None:
    artifact_id = await add(store, WEBM, ArtifactKind.recording, "video/webm")
    response = await client.get(url_for(signer, artifact_id), headers={"Range": header})
    assert response.status_code == 206
    assert response.content == WEBM[start : end + 1]
    assert response.headers["content-range"] == f"bytes {start}-{end}/{len(WEBM)}"
    assert response.headers["content-length"] == str(end - start + 1)
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-type"] == "video/webm"


@pytest.mark.parametrize("header", ["bytes=999999-", "bytes=999999-1000000", "bytes=-0"])
async def test_a_range_outside_the_file_is_416_with_the_size(
    client: httpx.AsyncClient, store: Any, signer: ArtifactSigner, header: str
) -> None:
    artifact_id = await add(store, WEBM, ArtifactKind.recording, "video/webm")
    response = await client.get(url_for(signer, artifact_id), headers={"Range": header})
    assert response.status_code == 416
    assert response.headers["content-range"] == f"bytes */{len(WEBM)}"
    assert response.json()["error"]["code"] == "range_not_satisfiable"


@pytest.mark.parametrize("header", ["bytes=0-1,5-6", "items=0-5", "bytes=9-2", "bytes=x-y", ""])
async def test_a_range_the_server_cannot_use_is_ignored_and_the_whole_file_returned(
    client: httpx.AsyncClient, store: Any, signer: ArtifactSigner, header: str
) -> None:
    artifact_id = await add(store, WEBM, ArtifactKind.recording, "video/webm")
    response = await client.get(url_for(signer, artifact_id), headers={"Range": header})
    assert response.status_code == 200
    assert response.content == WEBM


async def test_a_tampered_or_garbage_token_is_403(
    client: httpx.AsyncClient, store: Any, signer: ArtifactSigner
) -> None:
    artifact_id = await add(store, PNG, ArtifactKind.screenshot, "image/png")
    good = url_for(signer, artifact_id)
    bad_urls = [
        good[:-3] + ("AAA" if not good.endswith("AAA") else "BBB"),
        f"{ARTIFACT_URL_PREFIX}garbage",
        f"{ARTIFACT_URL_PREFIX}a.b.c",
        good.replace(artifact_id.hex, uuid.uuid4().hex),
    ]
    for url in bad_urls:
        response = await client.get(url)
        assert response.status_code == 403, url
        assert response.json()["error"]["code"] == "forbidden"


async def test_an_expired_link_is_403_and_a_fresh_one_for_the_same_file_works(
    client: httpx.AsyncClient, store: Any, signer: ArtifactSigner
) -> None:
    artifact_id = await add(store, PNG, ArtifactKind.screenshot, "image/png")
    long_ago = datetime.now(UTC) - timedelta(hours=2)
    expired = await client.get(url_for(signer, artifact_id, issued_at=long_ago))
    assert expired.status_code == 403
    assert expired.json()["error"]["code"] == "forbidden"
    fresh = await client.get(url_for(signer, artifact_id))
    assert fresh.status_code == 200


async def test_a_valid_link_to_a_deleted_artifact_is_404(
    client: httpx.AsyncClient, store: Any, signer: ArtifactSigner
) -> None:
    artifact_id = await add(store, PNG, ArtifactKind.screenshot, "image/png")
    link = url_for(signer, artifact_id)
    await store.delete(artifact_id)
    response = await client.get(link)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_media_is_never_compressed_even_when_the_client_accepts_gzip(
    client: httpx.AsyncClient, store: Any, signer: ArtifactSigner
) -> None:
    artifact_id = await add(store, WEBM, ArtifactKind.recording, "video/webm")
    response = await client.get(url_for(signer, artifact_id), headers={"Accept-Encoding": "gzip"})
    assert response.status_code == 200
    assert "content-encoding" not in response.headers
    assert response.headers["content-length"] == str(len(WEBM))
    ranged = await client.get(
        url_for(signer, artifact_id), headers={"Accept-Encoding": "gzip", "Range": "bytes=0-9"}
    )
    assert ranged.status_code == 206
    assert "content-encoding" not in ranged.headers
