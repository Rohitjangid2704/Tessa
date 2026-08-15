import logging
from collections.abc import AsyncIterator, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import Final, Literal, Protocol

from openai import AsyncOpenAI, OpenAIError

from tessa_api.schemas.enums import SecretName
from tessa_worker.grading.judge_openai import build_openai_client, map_openai_error
from tessa_worker.grading.judge_providers import ProviderKeys
from tessa_worker.grading.pricing import TokenUsage

logger = logging.getLogger("tessa_worker.findings.embedding")

FLOAT_ENCODING: Final[Literal["float"]] = "float"


@dataclass(frozen=True, slots=True)
class EmbeddingReply:
    vectors: list[list[float]]
    usage: TokenUsage | None


class EmbeddingProvider(Protocol):
    async def embed(
        self, model: str, texts: Sequence[str], dimensions: int, timeout_seconds: float
    ) -> EmbeddingReply: ...


class EmbeddingProviders(Protocol):
    def open(
        self, timeout_seconds: float
    ) -> AbstractAsyncContextManager[EmbeddingProvider | None]: ...


class OpenAIEmbeddings:
    def __init__(self, client: AsyncOpenAI) -> None:
        self.client = client

    async def embed(
        self, model: str, texts: Sequence[str], dimensions: int, timeout_seconds: float
    ) -> EmbeddingReply:
        try:
            response = await self.client.embeddings.create(
                model=model,
                input=list(texts),
                dimensions=dimensions,
                encoding_format=FLOAT_ENCODING,
                timeout=timeout_seconds,
            )
        except OpenAIError as error:
            logger.warning("openai_embedding_failed", extra={"error": type(error).__name__})
            raise map_openai_error(error) from None
        ordered = sorted(response.data, key=lambda item: item.index)
        return EmbeddingReply(
            vectors=[list(item.embedding) for item in ordered],
            usage=TokenUsage(input_tokens=response.usage.prompt_tokens, output_tokens=0),
        )


class KeyedEmbeddingProviders:
    def __init__(self, keys: ProviderKeys) -> None:
        self.keys = keys

    @asynccontextmanager
    async def open(self, timeout_seconds: float) -> AsyncIterator[EmbeddingProvider | None]:
        key = await self.keys.resolve(SecretName.openai_api_key)
        if key is None:
            yield None
            return
        client = build_openai_client(key.get_secret_value(), timeout_seconds)
        try:
            yield OpenAIEmbeddings(client)
        finally:
            await client.close()
