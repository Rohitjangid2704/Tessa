from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI

from tessa_api.schemas.enums import UserRole
from tessa_api.settings import Settings
from tests.stage_two.support import FakeTemporal
from tests.support import AuthHeaders, MakeUser, settings_with


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return settings_with(data_dir=tmp_path / "data")


@pytest.fixture
async def member_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.member))


@pytest.fixture
async def admin_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.admin))


@pytest.fixture
async def viewer_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.viewer))


@pytest.fixture
def temporal(db_app: FastAPI) -> FakeTemporal:
    fake = FakeTemporal()
    db_app.state.temporal = fake
    return fake
