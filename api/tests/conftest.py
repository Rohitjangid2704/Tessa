import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import command
from tessa_api.auth.jwt import encode_api_token
from tessa_api.auth.users import create_user
from tessa_api.db.models import User
from tessa_api.main import create_app
from tessa_api.schemas.enums import UserRole
from tessa_api.settings import Settings
from tests.support import TEST_PASSWORD, AuthHeaders, MakeUser, alembic_config, settings_with

TRUNCATE_ALL_TABLES = (
    "TRUNCATE TABLE idempotency_keys, run_events, settings, targets, users RESTART IDENTITY CASCADE"
)


@pytest.fixture(autouse=True)
def clean_tessa_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.upper().startswith("TESSA_"):
            monkeypatch.delenv(name)


@pytest.fixture
def settings() -> Settings:
    return settings_with()


@pytest.fixture(scope="session")
def migrated_database() -> None:
    command.upgrade(alembic_config(settings_with()), "head")


@pytest.fixture
async def database(settings: Settings, migrated_database: None) -> None:
    engine = create_async_engine(settings.database_url.get_secret_value())
    async with engine.begin() as connection:
        await connection.execute(text(TRUNCATE_ALL_TABLES))
    await engine.dispose()


@pytest.fixture
async def app(settings: Settings) -> AsyncIterator[FastAPI]:
    application = create_app(settings)
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http_client:
        yield http_client


@pytest.fixture
async def db_app(app: FastAPI, database: None) -> FastAPI:
    return app


@pytest.fixture
def make_user(db_app: FastAPI) -> MakeUser:
    counter = 0

    async def factory(
        role: UserRole = UserRole.member,
        email: str | None = None,
        password: str = TEST_PASSWORD,
        is_active: bool = True,
    ) -> User:
        nonlocal counter
        counter += 1
        async with db_app.state.session_factory() as session:
            user = await create_user(
                session,
                email=email or f"user{counter}@tessa.test",
                name=f"User {counter}",
                password=password,
                role=role,
            )
            if not is_active:
                user.is_active = False
                await session.commit()
            return user

    return factory


@pytest.fixture
def auth_headers(settings: Settings) -> AuthHeaders:
    def build(user: User, **token_options: Any) -> dict[str, str]:
        token = encode_api_token(settings, user.id, user.email, user.role, **token_options)
        return {"Authorization": f"Bearer {token}"}

    return build
