import logging

import httpx2
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    OpenAIError,
)
from openai.types.responses import Response
from openai.types.responses.response_usage import ResponseUsage

from tessa_worker.grading.effort import provider_effort
from tessa_worker.grading.errors import GradingErrorType
from tessa_worker.grading.judge_models import (
    JUDGE_ANSWER_SCHEMA,
    STRUCTURED_OUTPUT_NAME,
    JudgeRequest,
    ProviderCallError,
    ProviderReply,
    status_error,
    unavailable_error,
)
from tessa_worker.grading.pricing import TokenUsage
from tessa_worker.grading.sdk_logging import quiet_sdk_loggers

logger = logging.getLogger("tessa_worker.grading.judge_openai")

NO_SDK_RETRIES = 0
PROVIDER_NAME = "openai"
QUOTA_EXHAUSTED_CODE = "insufficient_quota"
FAILED_STATUS = "failed"
INCOMPLETE_STATUS = "incomplete"


def build_openai_client(
    api_key: str,
    timeout_seconds: float,
    base_url: str | None = None,
    http_client: httpx2.AsyncClient | None = None,
) -> AsyncOpenAI:
    quiet_sdk_loggers()
    return AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        max_retries=NO_SDK_RETRIES,
        timeout=timeout_seconds,
        http_client=http_client,
    )


def map_openai_error(error: OpenAIError) -> ProviderCallError:
    if isinstance(error, APITimeoutError):
        return unavailable_error(PROVIDER_NAME, "timed out")
    if isinstance(error, APIConnectionError):
        return unavailable_error(PROVIDER_NAME, "connection failed")
    if isinstance(error, APIStatusError):
        return status_error(PROVIDER_NAME, error.status_code, error.code == QUOTA_EXHAUSTED_CODE)
    return ProviderCallError(GradingErrorType.provider_rejected, "openai call failed", False)


def token_usage(usage: ResponseUsage | None) -> TokenUsage | None:
    if usage is None:
        return None
    details = usage.input_tokens_details
    return TokenUsage(
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        cached_input_tokens=details.cached_tokens if details is not None else 0,
        cache_write_tokens=details.cache_write_tokens if details is not None else 0,
    )


def has_refusal(response: Response) -> bool:
    return any(
        content.type == "refusal"
        for item in response.output
        if item.type == "message"
        for content in item.content
    )


def reply_from_response(response: Response) -> ProviderReply:
    if response.status == FAILED_STATUS:
        raise unavailable_error(PROVIDER_NAME, "response failed")
    return ProviderReply(
        text=response.output_text or None,
        usage=token_usage(response.usage),
        incomplete=response.status == INCOMPLETE_STATUS,
        refused=has_refusal(response),
    )


class OpenAIJudge:
    def __init__(self, client: AsyncOpenAI) -> None:
        self.client = client

    async def judge(self, request: JudgeRequest) -> ProviderReply:
        try:
            response = await self.client.responses.create(
                model=request.spec.model,
                instructions=request.instructions,
                input=request.input_text,
                max_output_tokens=request.spec.max_output_tokens,
                reasoning={"effort": provider_effort(request.spec.effort)},
                text={
                    "format": {
                        "type": "json_schema",
                        "name": STRUCTURED_OUTPUT_NAME,
                        "schema": JUDGE_ANSWER_SCHEMA,
                        "strict": True,
                    }
                },
                store=False,
                timeout=request.timeout_seconds,
            )
        except OpenAIError as error:
            logger.warning("openai_call_failed", extra={"error": type(error).__name__})
            raise map_openai_error(error) from None
        return reply_from_response(response)
