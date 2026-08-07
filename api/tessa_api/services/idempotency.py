import hashlib
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert

from tessa_api.db.models import IdempotencyKey
from tessa_api.db.session import SessionFactory
from tessa_api.errors import ApiError

IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"
KEY_PATTERN = r"^[\x21-\x7E]{8,128}$"
IN_PROGRESS_RETRY_SECONDS = 1

logger = logging.getLogger("tessa_api.idempotency")

IdempotencyKeyHeader = Annotated[
    str,
    Header(
        alias=IDEMPOTENCY_KEY_HEADER,
        description="Opaque client-generated key, 8 to 128 printable characters",
        pattern=KEY_PATTERN,
    ),
]


OptionalIdempotencyKeyHeader = Annotated[
    str | None,
    Header(
        alias=IDEMPOTENCY_KEY_HEADER,
        description="Opaque client-generated key, 8 to 128 printable characters; optional",
        pattern=KEY_PATTERN,
    ),
]


@dataclass(frozen=True)
class StoredResponse:
    status_code: int
    body: Any


def compute_request_hash(method: str, path: str, body: bytes) -> str:
    digest = hashlib.sha256()
    digest.update(method.upper().encode())
    digest.update(b"\n")
    digest.update(path.encode())
    digest.update(b"\n")
    digest.update(body)
    return digest.hexdigest()


async def begin(
    session_factory: SessionFactory,
    user_id: uuid.UUID,
    key: str,
    method: str,
    path: str,
    request_hash: str,
    ttl_hours: int,
) -> StoredResponse | None:
    now = datetime.now(UTC)
    async with session_factory() as session:
        await session.execute(delete(IdempotencyKey).where(IdempotencyKey.expires_at < now))
        inserted = await session.execute(
            insert(IdempotencyKey)
            .values(
                user_id=user_id,
                key=key,
                method=method.upper(),
                path=path,
                request_hash=request_hash,
                expires_at=now + timedelta(hours=ttl_hours),
            )
            .on_conflict_do_nothing(index_elements=[IdempotencyKey.user_id, IdempotencyKey.key])
            .returning(IdempotencyKey.key)
        )
        owns_key = inserted.scalar_one_or_none() is not None
        await session.commit()
    if owns_key:
        return None
    async with session_factory() as session:
        existing = await session.get(IdempotencyKey, (user_id, key))
    if existing is None:
        return await begin(session_factory, user_id, key, method, path, request_hash, ttl_hours)
    if existing.request_hash != request_hash:
        raise ApiError(
            409,
            "idempotency_conflict",
            "This Idempotency-Key was already used with a different request",
        )
    if existing.response_status is None:
        raise ApiError(
            409,
            "conflict",
            "A request with this Idempotency-Key is still in progress",
            headers={"Retry-After": str(IN_PROGRESS_RETRY_SECONDS)},
        )
    return StoredResponse(status_code=existing.response_status, body=existing.response_body)


async def complete(
    session_factory: SessionFactory,
    user_id: uuid.UUID,
    key: str,
    status_code: int,
    body: Any,
) -> None:
    async with session_factory() as session:
        stored = await session.get(IdempotencyKey, (user_id, key))
        if stored is None:
            return
        stored.response_status = status_code
        stored.response_body = body
        await session.commit()


async def abandon(session_factory: SessionFactory, user_id: uuid.UUID, key: str) -> None:
    async with session_factory() as session:
        await session.execute(
            delete(IdempotencyKey).where(
                IdempotencyKey.user_id == user_id,
                IdempotencyKey.key == key,
                IdempotencyKey.response_status.is_(None),
            )
        )
        await session.commit()


class IdempotencyContext:
    def __init__(self, session_factory: SessionFactory, user_id: uuid.UUID, key: str) -> None:
        self.session_factory = session_factory
        self.user_id = user_id
        self.key = key
        self.completed = False

    async def respond(self, body: BaseModel, status_code: int) -> JSONResponse:
        content = body.model_dump(mode="json")
        await complete(self.session_factory, self.user_id, self.key, status_code, content)
        self.completed = True
        return JSONResponse(status_code=status_code, content=content)

    async def release(self) -> None:
        if self.completed:
            return
        try:
            await abandon(self.session_factory, self.user_id, self.key)
        except Exception:
            logger.exception("idempotency_release_failed")
