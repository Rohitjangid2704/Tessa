import asyncio
import base64
import hashlib
import hmac
import json
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, Request
from pydantic import SecretStr

from tessa_api.errors import ApiError
from tessa_api.schemas.artifacts import ArtifactRef, StoredArtifact
from tessa_api.schemas.enums import ArtifactKind
from tessa_api.services.artifact_store import (
    ArtifactChunks,
    ArtifactContent,
    ArtifactNotFoundError,
    ArtifactStore,
    ByteRange,
    artifact_relative_path,
)
from tessa_api.services.storage import (
    Storage,
    StorageKey,
    StorageObjectNotFoundError,
    storage_from_settings,
    storage_key,
)
from tessa_api.settings import Settings, StrictSettings

ARTIFACT_URL_PREFIX = "/api/v1/artifacts/"
TOKEN_DOMAIN = b"artifact-url:"
TOKEN_SEPARATOR = "."
META_SUFFIX = ".meta.json"
META_CONTENT_TYPE = "application/json"
RANGE_UNIT = "bytes="
FILE_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "video/webm": "webm",
    "application/zip": "zip",
    "application/json": "json",
    "text/html": "html",
}
INLINE_MEDIA_PREFIXES = ("image/", "video/")


class InvalidArtifactTokenError(Exception):
    pass


class ExpiredArtifactTokenError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class ArtifactLink:
    artifact_id: uuid.UUID
    expires_at: datetime


class StorageArtifactStore:
    def __init__(self, storage: Storage) -> None:
        self.storage = storage

    def data_key(self, artifact_id: uuid.UUID) -> StorageKey:
        return storage_key(artifact_relative_path(artifact_id))

    def meta_key(self, artifact_id: uuid.UUID) -> StorageKey:
        return storage_key(f"{artifact_relative_path(artifact_id)}{META_SUFFIX}")

    def parse_info(
        self, artifact_id: uuid.UUID, meta: bytes | None, size_bytes: int | None
    ) -> StoredArtifact:
        if meta is None or size_bytes is None:
            raise ArtifactNotFoundError(artifact_id)
        try:
            document = json.loads(meta.decode("utf-8"))
            return StoredArtifact(
                id=artifact_id,
                kind=ArtifactKind(document["kind"]),
                mime=str(document["mime"]),
                size_bytes=size_bytes,
            )
        except (KeyError, TypeError, ValueError):
            raise ArtifactNotFoundError(artifact_id) from None

    async def put(
        self, artifact_id: uuid.UUID, content: ArtifactContent, kind: ArtifactKind, mime: str
    ) -> StoredArtifact:
        stored = await self.storage.put(self.data_key(artifact_id), content, mime)
        meta = json.dumps({"kind": kind.value, "mime": mime}).encode("utf-8")
        await self.storage.put(self.meta_key(artifact_id), meta, META_CONTENT_TYPE)
        return StoredArtifact(id=artifact_id, kind=kind, mime=mime, size_bytes=stored.size_bytes)

    async def info(self, artifact_id: uuid.UUID) -> StoredArtifact:
        meta, stat = await asyncio.gather(
            self.storage.get(self.meta_key(artifact_id)),
            self.storage.stat(self.data_key(artifact_id)),
        )
        return self.parse_info(artifact_id, meta, None if stat is None else stat.size_bytes)

    async def size(self, artifact_id: uuid.UUID) -> int:
        return (await self.info(artifact_id)).size_bytes

    async def open(
        self, artifact_id: uuid.UUID, byte_range: ByteRange | None = None
    ) -> ArtifactChunks:
        stored = await self.info(artifact_id)
        try:
            opened = await self.storage.open_read(self.data_key(artifact_id), byte_range)
        except StorageObjectNotFoundError:
            raise ArtifactNotFoundError(artifact_id) from None
        return ArtifactChunks(
            artifact=stored, start=opened.start, end=opened.end, chunks=opened.chunks
        )

    async def delete(self, artifact_id: uuid.UUID) -> None:
        await self.storage.delete(self.data_key(artifact_id))
        await self.storage.delete(self.meta_key(artifact_id))


class LocalArtifactStore(StorageArtifactStore):
    def __init__(self, data_dir: Path) -> None:
        from tessa_api.services.storage_local import LocalStorage

        super().__init__(LocalStorage(data_dir))


def b64_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


class ArtifactSigner:
    def __init__(self, signing_key: SecretStr, ttl_seconds: int) -> None:
        self.signing_key = signing_key
        self.ttl = timedelta(seconds=ttl_seconds)

    def signature(self, artifact_hex: str, expiry: int) -> str:
        message = TOKEN_DOMAIN + f"{artifact_hex}{TOKEN_SEPARATOR}{expiry}".encode("ascii")
        digest = hmac.new(
            self.signing_key.get_secret_value().encode("utf-8"), message, hashlib.sha256
        ).digest()
        return b64_encode(digest)

    def sign(
        self, artifact_id: uuid.UUID, issued_at: datetime | None = None
    ) -> tuple[str, datetime]:
        expires_at = (issued_at or datetime.now(UTC)) + self.ttl
        expiry = int(expires_at.timestamp())
        artifact_hex = artifact_id.hex
        signature = self.signature(artifact_hex, expiry)
        token = TOKEN_SEPARATOR.join((artifact_hex, str(expiry), signature))
        return token, datetime.fromtimestamp(expiry, UTC)

    def verify(self, token: str, now: datetime | None = None) -> ArtifactLink:
        parts = token.split(TOKEN_SEPARATOR)
        if len(parts) != 3:
            raise InvalidArtifactTokenError
        artifact_hex, expiry_text, signature = parts
        try:
            expiry = int(expiry_text)
            artifact_id = uuid.UUID(hex=artifact_hex)
        except ValueError:
            raise InvalidArtifactTokenError from None
        expected = self.signature(artifact_id.hex, expiry)
        if not hmac.compare_digest(expected.encode(), signature.encode()):
            raise InvalidArtifactTokenError
        expires_at = datetime.fromtimestamp(expiry, UTC)
        if (now or datetime.now(UTC)) >= expires_at:
            raise ExpiredArtifactTokenError
        return ArtifactLink(artifact_id=artifact_id, expires_at=expires_at)

    def reference(self, stored: StoredArtifact, issued_at: datetime | None = None) -> ArtifactRef:
        token, expires_at = self.sign(stored.id, issued_at)
        return ArtifactRef(
            id=stored.id,
            kind=stored.kind,
            mime=stored.mime,
            size_bytes=stored.size_bytes,
            url=f"{ARTIFACT_URL_PREFIX}{token}",
            expires_at=expires_at,
        )


def artifact_references(
    signer: ArtifactSigner, stored: Iterable[dict[str, Any]], issued_at: datetime | None = None
) -> list[ArtifactRef]:
    return [signer.reference(StoredArtifact.model_validate(entry), issued_at) for entry in stored]


@dataclass(frozen=True, slots=True)
class SuffixRange:
    length: int


RequestedRange = ByteRange | SuffixRange


def parse_range_header(header: str | None) -> RequestedRange | None:
    if header is None or not header.lower().startswith(RANGE_UNIT):
        return None
    spec = header[len(RANGE_UNIT) :].strip()
    if "," in spec or "-" not in spec:
        return None
    first, _, last = spec.partition("-")
    try:
        if first == "":
            return SuffixRange(length=int(last))
        start = int(first)
        end = int(last) if last else None
    except ValueError:
        return None
    if start < 0 or (end is not None and end < start):
        return None
    return ByteRange(start=start, end=end)


def resolve_requested_range(requested: RequestedRange | None, size_bytes: int) -> ByteRange | None:
    if isinstance(requested, SuffixRange):
        if requested.length <= 0:
            return ByteRange(start=size_bytes, end=None)
        return ByteRange(start=max(size_bytes - requested.length, 0), end=None)
    return requested


def content_disposition(stored: StoredArtifact) -> str:
    extension = FILE_EXTENSIONS.get(stored.mime, "bin")
    inline = stored.mime.startswith(INLINE_MEDIA_PREFIXES)
    disposition = "inline" if inline else "attachment"
    return f'{disposition}; filename="{stored.kind.value}-{stored.id.hex[:12]}.{extension}"'


def invalid_link_error() -> ApiError:
    return ApiError(403, "forbidden", "The link is invalid or has expired")


def range_not_satisfiable(size_bytes: int) -> ApiError:
    return ApiError(
        416,
        "range_not_satisfiable",
        "The requested range is outside the file",
        headers={"Content-Range": f"bytes */{size_bytes}"},
    )


def artifact_store_from_settings(settings: StrictSettings) -> ArtifactStore:
    return StorageArtifactStore(storage_from_settings(settings))


def get_artifact_store(request: Request) -> ArtifactStore:
    state = request.app.state
    store: ArtifactStore | None = getattr(state, "artifact_store", None)
    if store is None:
        store = artifact_store_from_settings(state.settings)
        state.artifact_store = store
    return store


def artifact_signer_from_settings(settings: Settings) -> ArtifactSigner:
    return ArtifactSigner(settings.signing_key, settings.media_url_ttl_seconds)


def get_artifact_signer(request: Request) -> ArtifactSigner:
    state = request.app.state
    signer: ArtifactSigner | None = getattr(state, "artifact_signer", None)
    if signer is None:
        signer = artifact_signer_from_settings(state.settings)
        state.artifact_signer = signer
    return signer


ArtifactStoreDep = Annotated[ArtifactStore, Depends(get_artifact_store)]
ArtifactSignerDep = Annotated[ArtifactSigner, Depends(get_artifact_signer)]
