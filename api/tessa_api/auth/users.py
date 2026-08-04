import asyncio
import logging
import uuid
from datetime import UTC, datetime
from functools import cache

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import User
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import UserRole
from tessa_api.settings import Settings

logger = logging.getLogger("tessa_api.auth")

password_hasher = PasswordHasher()


class DuplicateEmailError(Exception):
    pass


def normalize_email(email: str) -> str:
    return email.strip().lower()


@cache
def dummy_password_hash() -> str:
    return password_hasher.hash("tessa-unknown-user-placeholder")


def hash_password_sync(password: str) -> str:
    return password_hasher.hash(password)


def verify_password_sync(stored_hash: str | None, password: str) -> bool:
    try:
        return password_hasher.verify(stored_hash or dummy_password_hash(), password)
    except (VerificationError, InvalidHashError):
        return False


async def hash_password(password: str) -> str:
    return await asyncio.to_thread(hash_password_sync, password)


async def verify_password(stored_hash: str | None, password: str) -> bool:
    return await asyncio.to_thread(verify_password_sync, stored_hash, password)


async def get_user_by_email(session: AsyncSession, email: str) -> User | None:
    return await session.scalar(select(User).where(User.email == email.strip()))


async def insert_user(
    session: AsyncSession,
    email: str,
    name: str,
    password_hash: str | None,
    role: UserRole,
) -> User:
    user = User(email=normalize_email(email), name=name, password_hash=password_hash, role=role)
    try:
        async with session.begin_nested():
            session.add(user)
    except IntegrityError:
        raise DuplicateEmailError(email) from None
    return user


async def create_user(
    session: AsyncSession,
    email: str,
    name: str,
    password: str,
    role: UserRole,
) -> User:
    user = await insert_user(session, email, name, await hash_password(password), role)
    await session.commit()
    return user


async def authenticate(session: AsyncSession, email: str, password: str) -> User | None:
    user = await get_user_by_email(session, email)
    stored_hash = user.password_hash if user is not None else None
    password_valid = await verify_password(stored_hash, password)
    if user is None or stored_hash is None or not password_valid or not user.is_active:
        return None
    user.last_login_at = datetime.now(UTC)
    await session.commit()
    return user


async def ensure_bootstrap_admin(session_factory: SessionFactory, settings: Settings) -> bool:
    if not settings.bootstrap_admin_email:
        return False
    async with session_factory() as session:
        existing = await session.scalar(select(func.count()).select_from(User))
        if existing:
            return False
        try:
            await create_user(
                session,
                email=settings.bootstrap_admin_email,
                name="Admin",
                password=settings.bootstrap_admin_password.get_secret_value(),
                role=UserRole.admin,
            )
        except DuplicateEmailError:
            return False
    logger.info("bootstrap_admin_created", extra={"user_email": settings.bootstrap_admin_email})
    return True


async def get_user_by_id(session: AsyncSession, user_id: uuid.UUID) -> User | None:
    return await session.get(User, user_id)
