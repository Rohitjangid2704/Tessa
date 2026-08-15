from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Protocol

from pydantic import SecretStr

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import JudgeFamily, SecretName
from tessa_api.services.settings_service import resolve_secret
from tessa_api.services.vault import Vault
from tessa_worker.grading.judge_anthropic import AnthropicJudge, build_anthropic_client
from tessa_worker.grading.judge_models import JudgeProvider
from tessa_worker.grading.judge_openai import OpenAIJudge, build_openai_client
from tessa_worker.settings import WorkerSettings

PROVIDER_KEY_NAMES = {
    JudgeFamily.openai: SecretName.openai_api_key,
    JudgeFamily.anthropic: SecretName.anthropic_api_key,
}


class JudgeProviders(Protocol):
    def open(
        self, family: JudgeFamily, timeout_seconds: float
    ) -> AbstractAsyncContextManager[JudgeProvider | None]: ...


class ProviderKeys:
    def __init__(
        self, session_factory: SessionFactory, vault: Vault, settings: WorkerSettings
    ) -> None:
        self.session_factory = session_factory
        self.vault = vault
        self.settings = settings

    async def resolve(self, name: SecretName) -> SecretStr | None:
        async with self.session_factory() as session:
            return await resolve_secret(session, self.vault, self.settings, name)


class KeyedJudgeProviders:
    def __init__(self, keys: ProviderKeys) -> None:
        self.keys = keys

    @asynccontextmanager
    async def open(
        self, family: JudgeFamily, timeout_seconds: float
    ) -> AsyncIterator[JudgeProvider | None]:
        key = await self.keys.resolve(PROVIDER_KEY_NAMES[family])
        if key is None:
            yield None
            return
        if family is JudgeFamily.openai:
            openai_client = build_openai_client(key.get_secret_value(), timeout_seconds)
            try:
                yield OpenAIJudge(openai_client)
            finally:
                await openai_client.close()
            return
        anthropic_client = build_anthropic_client(key.get_secret_value(), timeout_seconds)
        try:
            yield AnthropicJudge(anthropic_client)
        finally:
            await anthropic_client.close()
