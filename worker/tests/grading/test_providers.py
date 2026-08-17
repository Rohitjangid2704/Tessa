import json
from typing import Any

import httpx2
import pytest

from tessa_api.schemas.enums import Effort
from tessa_worker.grading.effort import provider_effort
from tessa_worker.grading.errors import GradingErrorType
from tessa_worker.grading.judge_anthropic import (
    AnthropicJudge,
    build_anthropic_client,
)
from tessa_worker.grading.judge_models import (
    JUDGE_ANSWER_SCHEMA,
    JudgeRequest,
    ProviderCallError,
)
from tessa_worker.grading.judge_openai import OpenAIJudge, build_openai_client
from tessa_worker.grading.pricing import TokenUsage
from tests.fakes.openai import (
    FAKE_ANTHROPIC_KEY,
    FAKE_OPENAI_KEY,
    FakeProvider,
    ScriptedReply,
    anthropic_error,
    anthropic_message_body,
    anthropic_reply,
    openai_error,
    openai_reply,
    openai_response_body,
    valid_answer,
)
from tests.grading.support import model_spec, tiebreak_spec

INSTRUCTIONS = "grade the answer"
INPUT_TEXT = "<<<candidate x>>>\n{}\n<<<end candidate x>>>"


def request(spec: Any = None, timeout: float = 20.0) -> JudgeRequest:
    return JudgeRequest(spec or model_spec(), INSTRUCTIONS, INPUT_TEXT, timeout)


async def call_error(judge: Any, spec: Any = None) -> ProviderCallError:
    with pytest.raises(ProviderCallError) as caught:
        await judge.judge(request(spec))
    return caught.value


async def test_the_openai_request_uses_the_responses_api_with_structured_output(
    fake_provider: FakeProvider,
) -> None:
    fake_provider.enqueue_openai(openai_reply(valid_answer()))
    spec = model_spec(max_output_tokens=321, effort=Effort.medium)
    await OpenAIJudge(fake_provider.openai_client()).judge(request(spec))
    sent = fake_provider.openai_requests[0]
    assert sent.path == "/v1/responses"
    assert sent.body is not None
    assert sent.body["model"] == spec.model
    assert sent.body["instructions"] == INSTRUCTIONS
    assert sent.body["input"] == INPUT_TEXT
    assert sent.body["max_output_tokens"] == 321
    assert sent.body["reasoning"] == {"effort": "medium"}
    assert sent.body["store"] is False
    assert sent.body["text"]["format"] == {
        "type": "json_schema",
        "name": "judge_answer",
        "schema": JUDGE_ANSWER_SCHEMA,
        "strict": True,
    }


async def test_the_openai_judge_has_no_tools_and_no_tool_choice(
    fake_provider: FakeProvider,
) -> None:
    fake_provider.enqueue_openai(openai_reply(valid_answer()))
    await OpenAIJudge(fake_provider.openai_client()).judge(request())
    sent = fake_provider.openai_requests[0].body
    assert sent is not None
    assert "tools" not in sent
    assert "tool_choice" not in sent
    assert "previous_response_id" not in sent


async def test_the_openai_key_travels_only_in_the_authorization_header(
    fake_provider: FakeProvider,
) -> None:
    fake_provider.enqueue_openai(openai_reply(valid_answer()))
    await OpenAIJudge(fake_provider.openai_client()).judge(request())
    sent = fake_provider.openai_requests[0]
    assert sent.authorization == f"Bearer {FAKE_OPENAI_KEY}"
    assert FAKE_OPENAI_KEY not in json.dumps(sent.body)


@pytest.mark.parametrize("effort", list(Effort))
async def test_the_contract_effort_is_mapped_for_openai(
    fake_provider: FakeProvider, effort: Effort
) -> None:
    fake_provider.enqueue_openai(openai_reply(valid_answer()))
    await OpenAIJudge(fake_provider.openai_client()).judge(request(model_spec(effort=effort)))
    body = fake_provider.openai_requests[0].body
    assert body is not None
    assert body["reasoning"]["effort"] == provider_effort(effort)
    assert body["reasoning"]["effort"] != "minimal"


async def test_the_openai_reply_carries_text_and_token_usage(fake_provider: FakeProvider) -> None:
    fake_provider.enqueue_openai(
        openai_reply(
            valid_answer(),
            input_tokens=900,
            output_tokens=120,
            cached_tokens=300,
            reasoning_tokens=50,
        )
    )
    reply = await OpenAIJudge(fake_provider.openai_client()).judge(request())
    assert json.loads(reply.text or "") == valid_answer()
    assert reply.usage == TokenUsage(
        input_tokens=900, output_tokens=120, cached_input_tokens=300, cache_write_tokens=0
    )
    assert reply.incomplete is False
    assert reply.refused is False


async def test_an_incomplete_openai_response_is_flagged(fake_provider: FakeProvider) -> None:
    fake_provider.enqueue_openai(
        ScriptedReply(
            body=openai_response_body(
                '{"verdict": "pa', status="incomplete", incomplete_reason="max_output_tokens"
            )
        )
    )
    reply = await OpenAIJudge(fake_provider.openai_client()).judge(request())
    assert reply.incomplete is True


async def test_an_openai_refusal_is_flagged_and_has_no_text(fake_provider: FakeProvider) -> None:
    fake_provider.enqueue_openai(
        ScriptedReply(body=openai_response_body(None, refusal="I cannot help with that."))
    )
    reply = await OpenAIJudge(fake_provider.openai_client()).judge(request())
    assert reply.refused is True
    assert reply.text is None


async def test_an_openai_response_without_usage_reports_none(fake_provider: FakeProvider) -> None:
    fake_provider.enqueue_openai(
        ScriptedReply(body=openai_response_body(json.dumps(valid_answer()), with_usage=False))
    )
    reply = await OpenAIJudge(fake_provider.openai_client()).judge(request())
    assert reply.usage is None


async def test_a_failed_openai_response_is_a_retryable_error(fake_provider: FakeProvider) -> None:
    fake_provider.enqueue_openai(ScriptedReply(body=openai_response_body(None, status="failed")))
    error = await call_error(OpenAIJudge(fake_provider.openai_client()))
    assert error.retryable is True
    assert error.kind is GradingErrorType.provider_unavailable


@pytest.mark.parametrize(
    ("status", "code", "retryable"),
    [
        (400, None, False),
        (401, "invalid_api_key", False),
        (403, None, False),
        (404, "model_not_found", False),
        (422, None, False),
        (429, "insufficient_quota", False),
        (408, None, True),
        (409, None, True),
        (429, "rate_limit_exceeded", True),
        (500, None, True),
        (502, None, True),
        (503, None, True),
        (529, None, True),
    ],
)
async def test_openai_failures_are_classified(
    fake_provider: FakeProvider, status: int, code: str | None, retryable: bool
) -> None:
    fake_provider.enqueue_openai(openai_error(status, code))
    error = await call_error(OpenAIJudge(fake_provider.openai_client()))
    assert error.retryable is retryable
    expected = (
        GradingErrorType.provider_unavailable if retryable else GradingErrorType.provider_rejected
    )
    assert error.kind is expected
    assert str(status) in str(error)


@pytest.mark.parametrize("status", [429, 500, 503])
async def test_the_openai_sdk_never_retries_on_its_own(
    fake_provider: FakeProvider, status: int
) -> None:
    client = fake_provider.openai_client()
    assert client.max_retries == 0
    fake_provider.enqueue_openai(openai_error(status), openai_reply(valid_answer()))
    await call_error(OpenAIJudge(client))
    assert len(fake_provider.openai_requests) == 1


async def test_an_openai_connection_failure_is_retryable() -> None:
    def refuse(_request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("refused")

    http_client = httpx2.AsyncClient(transport=httpx2.MockTransport(refuse))
    client = build_openai_client(
        FAKE_OPENAI_KEY, 5.0, base_url="http://unreachable.test/v1", http_client=http_client
    )
    error = await call_error(OpenAIJudge(client))
    assert error.retryable is True
    assert error.kind is GradingErrorType.provider_unavailable


async def test_the_error_text_never_carries_the_provider_message(
    fake_provider: FakeProvider,
) -> None:
    fake_provider.enqueue_openai(
        ScriptedReply(status_code=400, body={"error": {"message": "echo of my secret input"}})
    )
    error = await call_error(OpenAIJudge(fake_provider.openai_client()))
    assert "secret input" not in str(error)


async def test_the_anthropic_request_uses_messages_with_structured_output(
    fake_provider: FakeProvider,
) -> None:
    fake_provider.enqueue_anthropic(anthropic_reply(valid_answer()))
    spec = tiebreak_spec(max_output_tokens=222, effort=Effort.high)
    await AnthropicJudge(fake_provider.anthropic_client()).judge(request(spec))
    sent = fake_provider.anthropic_requests[0]
    assert sent.path == "/v1/messages"
    assert sent.body is not None
    assert sent.body["model"] == spec.model
    assert sent.body["max_tokens"] == 222
    assert sent.body["system"] == INSTRUCTIONS
    assert sent.body["messages"] == [{"role": "user", "content": INPUT_TEXT}]
    assert sent.body["output_config"] == {
        "effort": "high",
        "format": {"type": "json_schema", "schema": JUDGE_ANSWER_SCHEMA},
    }
    assert "tools" not in sent.body
    assert sent.authorization == FAKE_ANTHROPIC_KEY


@pytest.mark.parametrize("effort", list(Effort))
async def test_the_contract_effort_is_mapped_for_anthropic(
    fake_provider: FakeProvider, effort: Effort
) -> None:
    fake_provider.enqueue_anthropic(anthropic_reply(valid_answer()))
    await AnthropicJudge(fake_provider.anthropic_client()).judge(
        request(tiebreak_spec(effort=effort))
    )
    body = fake_provider.anthropic_requests[0].body
    assert body is not None
    assert body["output_config"]["effort"] == provider_effort(effort)


async def test_the_anthropic_reply_sums_cache_tokens_into_the_input_total(
    fake_provider: FakeProvider,
) -> None:
    fake_provider.enqueue_anthropic(
        anthropic_reply(
            valid_answer(),
            input_tokens=100,
            output_tokens=40,
            cache_read_tokens=500,
            cache_write_tokens=200,
        )
    )
    reply = await AnthropicJudge(fake_provider.anthropic_client()).judge(request(tiebreak_spec()))
    assert reply.usage == TokenUsage(
        input_tokens=800, output_tokens=40, cached_input_tokens=500, cache_write_tokens=200
    )


@pytest.mark.parametrize(
    ("stop_reason", "incomplete", "refused"),
    [("end_turn", False, False), ("max_tokens", True, False), ("refusal", False, True)],
)
async def test_the_anthropic_stop_reason_is_surfaced(
    fake_provider: FakeProvider, stop_reason: str, incomplete: bool, refused: bool
) -> None:
    fake_provider.enqueue_anthropic(
        ScriptedReply(body=anthropic_message_body("{}", stop_reason=stop_reason))
    )
    reply = await AnthropicJudge(fake_provider.anthropic_client()).judge(request(tiebreak_spec()))
    assert reply.incomplete is incomplete
    assert reply.refused is refused


@pytest.mark.parametrize(
    ("status", "error_type", "retryable"),
    [
        (400, "invalid_request_error", False),
        (401, "authentication_error", False),
        (403, "permission_error", False),
        (404, "not_found_error", False),
        (429, "rate_limit_error", True),
        (500, "api_error", True),
        (529, "overloaded_error", True),
    ],
)
async def test_anthropic_failures_are_classified(
    fake_provider: FakeProvider, status: int, error_type: str, retryable: bool
) -> None:
    fake_provider.enqueue_anthropic(anthropic_error(status, error_type))
    error = await call_error(AnthropicJudge(fake_provider.anthropic_client()), tiebreak_spec())
    assert error.retryable is retryable


async def test_the_anthropic_sdk_never_retries_on_its_own(fake_provider: FakeProvider) -> None:
    client = fake_provider.anthropic_client()
    assert client.max_retries == 0
    fake_provider.enqueue_anthropic(anthropic_error(529, "overloaded_error"), anthropic_reply({}))
    await call_error(AnthropicJudge(client), tiebreak_spec())
    assert len(fake_provider.anthropic_requests) == 1


def test_the_production_builders_turn_sdk_retries_off() -> None:
    assert build_openai_client("dev-only-key-not-real", 5.0).max_retries == 0
    assert build_anthropic_client("dev-only-key-not-real", 5.0).max_retries == 0
