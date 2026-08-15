import logging

import httpx2
from anthropic import (
    AnthropicError,
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncAnthropic,
)
from anthropic.types import Message, Usage

from tessa_worker.grading.effort import provider_effort
from tessa_worker.grading.errors import GradingErrorType
from tessa_worker.grading.judge_models import (
    JUDGE_ANSWER_SCHEMA,
    JudgeRequest,
    ProviderCallError,
    ProviderReply,
    status_error,
    unavailable_error,
)
from tessa_worker.grading.pricing import TokenUsage
from tessa_worker.grading.sdk_logging import quiet_sdk_loggers

logger = logging.getLogger("tessa_worker.grading.judge_anthropic")

NO_SDK_RETRIES = 0
PROVIDER_NAME = "anthropic"
TRUNCATED_STOP_REASON = "max_tokens"
REFUSAL_STOP_REASON = "refusal"


def build_anthropic_client(
    api_key: str,
    timeout_seconds: float,
    base_url: str | None = None,
    http_client: httpx2.AsyncClient | None = None,
) -> AsyncAnthropic:
    quiet_sdk_loggers()
    return AsyncAnthropic(
        api_key=api_key,
        base_url=base_url,
        max_retries=NO_SDK_RETRIES,
        timeout=timeout_seconds,
        http_client=http_client,
    )


def map_anthropic_error(error: AnthropicError) -> ProviderCallError:
    if isinstance(error, APITimeoutError):
        return unavailable_error(PROVIDER_NAME, "timed out")
    if isinstance(error, APIConnectionError):
        return unavailable_error(PROVIDER_NAME, "connection failed")
    if isinstance(error, APIStatusError):
        return status_error(PROVIDER_NAME, error.status_code)
    return ProviderCallError(GradingErrorType.provider_rejected, "anthropic call failed", False)


def token_usage(usage: Usage | None) -> TokenUsage | None:
    if usage is None:
        return None
    cache_written = usage.cache_creation_input_tokens or 0
    cache_read = usage.cache_read_input_tokens or 0
    return TokenUsage(
        input_tokens=usage.input_tokens + cache_written + cache_read,
        output_tokens=usage.output_tokens,
        cached_input_tokens=cache_read,
        cache_write_tokens=cache_written,
    )


def message_text(message: Message) -> str | None:
    text = "".join(block.text for block in message.content if block.type == "text")
    return text or None


def reply_from_message(message: Message) -> ProviderReply:
    return ProviderReply(
        text=message_text(message),
        usage=token_usage(message.usage),
        incomplete=message.stop_reason == TRUNCATED_STOP_REASON,
        refused=message.stop_reason == REFUSAL_STOP_REASON,
    )


class AnthropicJudge:
    def __init__(self, client: AsyncAnthropic) -> None:
        self.client = client

    async def judge(self, request: JudgeRequest) -> ProviderReply:
        try:
            message = await self.client.messages.create(
                model=request.spec.model,
                max_tokens=request.spec.max_output_tokens,
                system=request.instructions,
                messages=[{"role": "user", "content": request.input_text}],
                output_config={
                    "effort": provider_effort(request.spec.effort),
                    "format": {"type": "json_schema", "schema": JUDGE_ANSWER_SCHEMA},
                },
                timeout=request.timeout_seconds,
            )
        except AnthropicError as error:
            logger.warning("anthropic_call_failed", extra={"error": type(error).__name__})
            raise map_anthropic_error(error) from None
        return reply_from_message(message)
