import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from alembic.config import Config

from tessa_api.db.models import User
from tessa_api.settings import ENV_PREFIX, Settings

API_ROOT = Path(__file__).resolve().parent.parent
ENV_TEST_PATH = Path(os.environ.get("TEST_ENV_FILE", API_ROOT / ".env.test"))
ENV_EXAMPLE_PATH = API_ROOT / ".env.example"
TEST_PASSWORD = "dev-only-test-password-1"
SUITE_OVERRIDABLE_KEYS = (
    "TESSA_DATABASE_URL",
    "TESSA_TEMPORAL_ADDRESS",
    "TESSA_TEMPORAL_TASK_QUEUE",
    "TESSA_DATA_DIR",
)
SUITE_ENV_OVERRIDES = {
    key: os.environ[key] for key in SUITE_OVERRIDABLE_KEYS if os.environ.get(key)
}

MakeUser = Callable[..., Awaitable[User]]
AuthHeaders = Callable[..., dict[str, str]]


def alembic_config(settings: Settings) -> Config:
    config = Config(str(API_ROOT / "alembic.ini"))
    config.attributes["database_url"] = settings.database_url.get_secret_value()
    return config


def suite_field_overrides() -> dict[str, str]:
    return {
        key.removeprefix(ENV_PREFIX).lower(): value for key, value in SUITE_ENV_OVERRIDES.items()
    }


def suite_env_values() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in ENV_TEST_PATH.read_text(encoding="utf-8").splitlines():
        key, _, value = line.partition("=")
        if key:
            values[key] = value
    values.update(SUITE_ENV_OVERRIDES)
    return values


def settings_with(**overrides: Any) -> Settings:
    return Settings(_env_file=ENV_TEST_PATH, **{**suite_field_overrides(), **overrides})
