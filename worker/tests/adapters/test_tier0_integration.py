from typing import Any

import pytest

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.scenario import HttpStep, SseStep
from tessa_worker.adapters.http import HttpAdapter
from tessa_worker.adapters.sse import SseAdapter
from tessa_worker.checks.tier0 import evaluate_tier0
from tests.adapters.support import local_context
from tests.adapters.test_http_adapter import api_context
from tests.adapters.test_sse_adapter import chat_context
from tests.checks.support import CONTEXT, checks_of
from tests.fake_target.server import RunningTarget


def api_step(path: str, expect: dict[str, Any], query: dict[str, Any] | None = None) -> HttpStep:
    return HttpStep.model_validate(
        {
            "adapter": "http",
            "request": {"method": "GET", "path": path, "query": query or {}},
            "expect": expect,
        }
    )


def chat_step(message: str, expect: dict[str, Any]) -> SseStep:
    return SseStep.model_validate(
        {
            "adapter": "sse",
            "request": {"method": "POST", "path": "/message", "body": {"message": message}},
            "expect": expect,
        }
    )


async def test_a_rooms_read_passes_every_http_check_against_the_live_target(
    fake_target: RunningTarget,
) -> None:
    step = api_step(
        "/rooms",
        {
            "status": 200,
            "schema": {
                "type": "object",
                "required": ["items", "total"],
                "properties": {"items": {"type": "array"}, "total": {"type": "integer"}},
            },
            "fields": [
                {"path": "total", "gte": 1},
                {"path": "items[0].number", "matches": "^\\d{5}$"},
                {"path": "items[0].status", "type": "string"},
            ],
            "latency": {"max_ms": 5000},
        },
        {"status": "dirty"},
    )
    adapter = HttpAdapter(api_context(fake_target, role="manager"))
    try:
        record = await adapter.drive(step)
    finally:
        await adapter.close()
    result = evaluate_tier0(record, step.expect, CONTEXT)
    assert result.passed is True, result.failures


async def test_the_role_boundary_is_checked_by_status(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(api_context(fake_target, role="manager"))
    try:
        forbidden = await adapter.drive(api_step("/admin/users", {"status": 403}))
        wrong = await adapter.drive(api_step("/admin/users", {"status": 200}))
    finally:
        await adapter.close()
    assert evaluate_tier0(forbidden, api_step("/x", {"status": 403}).expect, CONTEXT).passed
    failed = evaluate_tier0(wrong, api_step("/x", {"status": 200}).expect, CONTEXT)
    assert checks_of(failed.failures) == [Tier0Check.status]
    assert failed.failures[0].actual == 403


async def test_a_chat_answer_passes_tools_cards_text_and_latency_checks(
    fake_target: RunningTarget,
) -> None:
    step = chat_step(
        "Which maintenance issues are still open?",
        {
            "status": 200,
            "events": {"include": ["done"], "exclude": ["error"]},
            "tools": {"include": [{"name": "query_issues", "args": {"status": "open"}}]},
            "cards": {"min_count": 1, "include": [{"kind": "issue_list", "count": 3}]},
            "text_contains": ["3 maintenance issues", "20003"],
            "text_not_contains": ["I have created"],
            "latency": {"max_ms": 10000, "max_first_byte_ms": 5000},
        },
    )
    adapter = SseAdapter(chat_context(fake_target, role="manager"))
    try:
        record = await adapter.drive(step)
    finally:
        await adapter.close()
    result = evaluate_tier0(record, step.expect, CONTEXT)
    assert result.passed is True, result.failures


async def test_a_write_request_is_confirmed_before_any_claim(fake_target: RunningTarget) -> None:
    step = chat_step(
        "Create a maintenance issue for room 20003, the shower leaks",
        {
            "tools": {"include": ["draft_issue"], "exclude": ["create_issue"]},
            "cards": {"include": [{"kind": "confirmation", "room": "20003"}]},
            "text_contains": ["confirm"],
            "text_not_contains": ["I have created", "has been created"],
        },
    )
    adapter = SseAdapter(chat_context(fake_target, role="staff"))
    try:
        record = await adapter.drive(step)
    finally:
        await adapter.close()
    assert evaluate_tier0(record, step.expect, CONTEXT).passed is True


async def test_the_deliberate_leak_of_the_fake_target_is_caught_by_the_internal_id_check(
    fake_target: RunningTarget,
) -> None:
    step = chat_step("What is the internal id of room 20003?", {"non_empty_answer": True})
    adapter = SseAdapter(chat_context(fake_target, role="manager"))
    try:
        record = await adapter.drive(step)
    finally:
        await adapter.close()
    result = evaluate_tier0(record, step.expect, CONTEXT)
    assert checks_of(result.failures) == [Tier0Check.internal_ids]
    found = result.failures[0].actual
    assert isinstance(found, list)
    assert any(str(item).startswith("room_id 4002") for item in found)


async def test_a_stream_that_never_ends_fails_the_status_check(fake_target: RunningTarget) -> None:
    adapter = SseAdapter(local_context(fake_target.base_url, kind="sse", step_timeout_seconds=0.4))
    step = SseStep.model_validate(
        {
            "adapter": "sse",
            "request": {"method": "GET", "path": "/hang"},
            "expect": {"events": {"include": ["done"]}},
        }
    )
    try:
        record = await adapter.drive(step)
    finally:
        await adapter.close()
    result = evaluate_tier0(record, step.expect, CONTEXT)
    assert checks_of(result.failures) == [Tier0Check.status, Tier0Check.status]
    assert "did not end" in result.failures[0].message
    assert "no done event" in result.failures[1].message


async def test_a_response_cut_by_the_payload_cap_cannot_be_checked_against_a_schema(
    fake_target: RunningTarget,
) -> None:
    step = HttpStep.model_validate(
        {
            "adapter": "http",
            "request": {"method": "GET", "path": "/big", "query": {"kb": 64}},
            "expect": {"schema": {"type": "object", "required": ["items"]}, "internal_ids": False},
        }
    )
    adapter = HttpAdapter(local_context(fake_target.base_url, max_payload_bytes=2048))
    try:
        record = await adapter.drive(step)
    finally:
        await adapter.close()
    result = evaluate_tier0(record, step.expect, CONTEXT)
    assert checks_of(result.failures) == [Tier0Check.schema]
    assert "cut at the payload limit" in result.failures[0].message


@pytest.mark.parametrize(
    "message", ["Which rooms are dirty?", "Which maintenance issues are still open?"]
)
async def test_the_smoke_style_tier0_expectations_pass_for_the_bundle_examples(
    fake_target: RunningTarget, message: str
) -> None:
    step = chat_step(message, {"status": 200, "non_empty_answer": True, "internal_ids": True})
    adapter = SseAdapter(chat_context(fake_target, role="staff"))
    try:
        record = await adapter.drive(step)
    finally:
        await adapter.close()
    assert evaluate_tier0(record, step.expect, CONTEXT).passed is True
