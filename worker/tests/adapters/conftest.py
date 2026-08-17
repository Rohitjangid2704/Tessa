from collections.abc import Iterator

import httpx
import pytest
from fastapi import FastAPI

from tessa_api.settings import Settings
from tests.adapters.support import RegisteredTarget, register_fake_target
from tests.fake_target.server import RunningTarget


@pytest.fixture
def fake_target() -> Iterator[RunningTarget]:
    with RunningTarget() as running:
        yield running


@pytest.fixture
async def registered(
    api_app: FastAPI,
    asgi_client: httpx.AsyncClient,
    api_settings: Settings,
    fake_target: RunningTarget,
) -> RegisteredTarget:
    return await register_fake_target(api_app, asgi_client, api_settings, fake_target)
