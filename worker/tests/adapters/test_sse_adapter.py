import asyncio
import json
import socket
from collections.abc import AsyncIterator
from typing import Any

import pytest

from tessa_api.schemas.enums import AdapterKind
from tessa_api.schemas.scenario import HttpStep, SseStep
from tessa_api.schemas.steps import SseStepRequest, SseStepResponse
from tessa_worker.adapters.base import Adapter, StepRecord
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.sse import SseAdapter
from tests.adapters.support import RegisteredTarget, local_context
from tests.fake_target.dataset import ADMIN_TOKEN, MANAGER_TOKEN, STAFF_EMAIL, STAFF_PASSWORD
from tests.fake_target.server import RunningTarget

LOGIN = "POST /api/auth/login with ${STAFF_EMAIL} and ${STAFF_PASSWORD}"
BEARER_AUTH: dict[str, Any] = {
    "type": "bearer",
    "token_source": {"staff": LOGIN, "manager": "${MANAGER_TOKEN}", "admin": "${ADMIN_TOKEN}"},
}
CREDENTIALS = {
    "STAFF_EMAIL": STAFF_EMAIL,
    "STAFF_PASSWORD": STAFF_PASSWORD,
    "MANAGER_TOKEN": MANAGER_TOKEN,
    "ADMIN_TOKEN": ADMIN_TOKEN,
}


def chat(
    message: str | None,
    ask: str | None = None,
    label: str | None = None,
    identity: str | None = None,
) -> SseStep:
    document: dict[str, Any] = {
        "adapter": "sse",
        "request": {"method": "POST", "path": "/message", "body": {"message": message}},
    }
    if ask is not None:
        document["ask"] = ask
    if label is not None:
        document["label"] = label
    if identity is not None:
        document["as"] = identity
    return SseStep.model_validate(document)


def stream(path: str, query: dict[str, Any] | None = None) -> SseStep:
    return SseStep.model_validate(
        {"adapter": "sse", "request": {"method": "GET", "path": path, "query": query or {}}}
    )


def chat_context(running: RunningTarget, role: str = "staff", **overrides: Any) -> AdapterContext:
    return local_context(
        running.base_url,
        kind="sse",
        base_path="/api/chat",
        auth=BEARER_AUTH,
        values=CREDENTIALS,
        role=role,
        **overrides,
    )


@pytest.fixture
async def staff(fake_target: RunningTarget) -> AsyncIterator[SseAdapter]:
    adapter = SseAdapter(chat_context(fake_target))
    yield adapter
    await adapter.close()


def response_of(record: StepRecord) -> SseStepResponse:
    assert isinstance(record.response, SseStepResponse)
    return record.response


def event_names(record: StepRecord) -> list[str | None]:
    return [event.event for event in response_of(record).events]


def persisted(record: StepRecord) -> str:
    return record.model_dump_json()


def test_the_adapter_satisfies_the_protocol_and_reports_its_kind(
    fake_target: RunningTarget,
) -> None:
    adapter = SseAdapter(chat_context(fake_target))
    assert isinstance(adapter, Adapter)
    assert adapter.kind is AdapterKind.sse


async def test_a_chat_stream_is_aggregated_into_answer_tools_and_cards(
    staff: SseAdapter,
) -> None:
    record = await staff.drive(chat("Which maintenance issues are still open?"))
    response = response_of(record)
    assert record.adapter is AdapterKind.sse
    assert record.ok is True
    assert record.error is None
    assert response.status == 200
    assert response.closed_by == "server"
    names = event_names(record)
    assert names[0] == "tool_call"
    assert names[-1] == "done"
    assert names.count("card") == 1
    assert set(names) == {"tool_call", "token", "card", "done"}
    assert record.answer == (
        "3 maintenance issues are open across 2 rooms, most of them in room 20003 (2 issues)."
    )
    assert [(tool.name, tool.args, tool.result_summary) for tool in record.tools] == [
        ("query_issues", {"status": "open"}, "3 rows")
    ]
    assert record.cards == [{"kind": "issue_list", "count": 3, "rooms": ["20003", "20005"]}]
    assert record.cost_usd == 0.0
    assert record.ask == "Which maintenance issues are still open?"
    assert record.label == "POST /message"


async def test_the_events_carry_names_data_and_a_rising_time(staff: SseAdapter) -> None:
    record = await staff.drive(chat("Which rooms are dirty?"))
    events = response_of(record).events
    assert json.loads(events[0].data)["name"] == "query_rooms"
    assert all(event.at_ms >= 0 for event in events)
    assert [event.at_ms for event in events] == sorted(event.at_ms for event in events)
    assert events[-1].at_ms <= record.latency_ms


async def test_the_request_is_persisted_as_the_sse_step_request(staff: SseAdapter) -> None:
    record = await staff.drive(chat("Which rooms are dirty?"))
    request = record.request
    assert isinstance(request, SseStepRequest)
    assert request.kind == "sse"
    assert request.method == "POST"
    assert request.url.endswith("/api/chat/message")
    assert request.body == {"message": "Which rooms are dirty?"}
    assert request.headers["Accept"] == "text/event-stream"
    assert request.headers["Authorization"] == "Bearer ${STAFF_SESSION_TOKEN}"


async def test_a_dirty_rooms_question_gets_its_tool_and_card(staff: SseAdapter) -> None:
    record = await staff.drive(chat("Which rooms are dirty?"))
    assert record.answer == "3 rooms are dirty: 20002, 20003, 20005."
    assert [tool.name for tool in record.tools] == ["query_rooms"]
    assert record.cards == [{"kind": "room_list", "count": 3, "rooms": ["20002", "20003", "20005"]}]


async def test_a_write_request_ends_with_a_confirmation_card_and_no_claim(
    staff: SseAdapter,
) -> None:
    record = await staff.drive(chat("Create a maintenance issue for room 20003, the shower leaks"))
    assert record.answer is not None
    assert "Please confirm" in record.answer
    assert "created" not in record.answer.lower().replace("create a", "")
    assert [tool.name for tool in record.tools] == ["draft_issue"]
    assert record.cards[0]["kind"] == "confirmation"
    assert record.cards[0]["room"] == "20003"


async def test_a_question_without_tools_or_cards_has_empty_lists_and_an_answer(
    staff: SseAdapter,
) -> None:
    record = await staff.drive(chat("Tell me a joke"))
    assert record.answer == "I can answer questions about rooms and maintenance issues."
    assert record.tools == []
    assert record.cards == []


async def test_a_leaky_answer_is_recorded_as_it_came(staff: SseAdapter) -> None:
    record = await staff.drive(chat("What is the internal id of room 20003?"))
    assert record.answer is not None
    assert "room_id 4002" in record.answer


async def test_an_explicit_ask_wins_over_the_one_derived_from_the_body(staff: SseAdapter) -> None:
    record = await staff.drive(chat("Which rooms are dirty?", ask="Dirty rooms?"))
    assert record.ask == "Dirty rooms?"


async def test_a_label_in_the_scenario_wins_over_the_derived_one(staff: SseAdapter) -> None:
    record = await staff.drive(chat("Which rooms are dirty?", label="Ask for dirty rooms"))
    assert record.label == "Ask for dirty rooms"


async def test_the_staff_login_runs_once_and_the_session_token_is_never_persisted(
    fake_target: RunningTarget, staff: SseAdapter
) -> None:
    first = await staff.drive(chat("Which rooms are dirty?"))
    second = await staff.drive(chat("Which rooms are dirty?"))
    logins = [r for r in fake_target.state.requests if r.path == "/api/auth/login"]
    assert len(logins) == 1
    sent = next(r for r in fake_target.state.requests if r.path == "/api/chat/message")
    token = (sent.headers["authorization"]).removeprefix("Bearer ")
    assert token.startswith("fake-session-")
    for record in (first, second):
        assert token not in persisted(record)
        assert STAFF_PASSWORD not in persisted(record)


async def test_a_static_token_role_streams_with_the_vault_token(
    fake_target: RunningTarget,
) -> None:
    adapter = SseAdapter(chat_context(fake_target, role="manager"))
    try:
        record = await adapter.drive(chat("Which rooms are dirty?"))
    finally:
        await adapter.close()
    assert record.ok is True
    sent = next(r for r in fake_target.state.requests if r.path == "/api/chat/message")
    assert sent.headers["authorization"] == f"Bearer {MANAGER_TOKEN}"
    assert MANAGER_TOKEN not in persisted(record)


async def test_an_unauthenticated_stream_keeps_the_error_body_as_body_text(
    staff: SseAdapter,
) -> None:
    record = await staff.drive(chat("Which rooms are dirty?", identity="anonymous"))
    response = response_of(record)
    assert record.ok is True
    assert response.status == 401
    assert response.events == []
    assert response.model_extra is not None
    assert json.loads(response.model_extra["body_text"]) == {"detail": "unauthenticated"}
    assert record.answer is None


async def test_a_json_endpoint_driven_as_a_stream_is_kept_as_body_text(
    fake_target: RunningTarget,
) -> None:
    adapter = SseAdapter(chat_context(fake_target, role="manager"))
    try:
        record = await adapter.drive(
            SseStep.model_validate(
                {"adapter": "sse", "request": {"method": "GET", "path": "/../rooms"}}
            )
        )
    finally:
        await adapter.close()
    assert record.ok is True
    assert record.answer is None
    assert response_of(record).events == []


async def test_a_secret_echoed_in_events_tools_and_cards_is_redacted(
    fake_target: RunningTarget,
) -> None:
    adapter = SseAdapter(
        local_context(
            fake_target.base_url,
            kind="sse",
            auth={"type": "bearer", "token_source": {"staff": "${ADMIN_TOKEN}"}},
            values={"ADMIN_TOKEN": ADMIN_TOKEN},
        )
    )
    try:
        record = await adapter.drive(stream("/sse-echo"))
    finally:
        await adapter.close()
    assert record.answer == "Bearer ${ADMIN_TOKEN}"
    assert record.tools[0].args == {"authorization": "Bearer ${ADMIN_TOKEN}"}
    assert record.cards == [{"kind": "echo", "authorization": "Bearer ${ADMIN_TOKEN}"}]
    assert ADMIN_TOKEN not in persisted(record)


async def test_a_secret_split_over_two_events_is_blanked_out_of_the_events(
    fake_target: RunningTarget,
) -> None:
    adapter = SseAdapter(
        local_context(
            fake_target.base_url,
            kind="sse",
            auth={"type": "bearer", "token_source": {"staff": "${ADMIN_TOKEN}"}},
            values={"ADMIN_TOKEN": ADMIN_TOKEN},
        )
    )
    try:
        record = await adapter.drive(stream("/sse-echo", {"split": True}))
    finally:
        await adapter.close()
    assert record.answer == "Bearer ${ADMIN_TOKEN}"
    stored = persisted(record)
    assert ADMIN_TOKEN not in stored
    assert ADMIN_TOKEN[:12] not in stored
    assert all(
        "a secret spans several events" in event.data for event in response_of(record).events
    )


async def test_a_stream_that_never_ends_times_out_with_the_events_so_far(
    fake_target: RunningTarget,
) -> None:
    adapter = SseAdapter(local_context(fake_target.base_url, kind="sse", step_timeout_seconds=0.5))
    try:
        record = await adapter.drive(stream("/hang"))
    finally:
        await adapter.close()
    response = response_of(record)
    assert record.ok is False
    assert record.error == "the stream did not end within 0.5s"
    assert response.closed_by == "timeout"
    assert response.status == 200
    assert [event.event for event in response.events] == ["token"]
    assert record.answer == "partial "
    assert 400 <= record.latency_ms < 3000


async def test_a_stream_over_the_read_limit_is_cut_and_flagged(
    fake_target: RunningTarget,
) -> None:
    adapter = SseAdapter(local_context(fake_target.base_url, kind="sse", max_payload_bytes=1024))
    try:
        record = await adapter.drive(stream("/sse-flood", {"kb": 256}))
    finally:
        await adapter.close()
    response = response_of(record)
    assert record.ok is True
    assert response.closed_by == "limit"
    assert record.response_truncated is True
    assert sum(len(event.data) for event in response.events) <= 1024
    assert record.answer is not None
    assert len(record.answer.encode()) <= 1024


async def test_events_over_the_payload_cap_are_dropped_from_the_record_only(
    fake_target: RunningTarget,
) -> None:
    adapter = SseAdapter(chat_context(fake_target, role="manager", max_payload_bytes=400))
    try:
        record = await adapter.drive(chat("Which maintenance issues are still open?"))
    finally:
        await adapter.close()
    assert record.response_truncated is True
    assert len(response_of(record).events) < 22
    assert record.answer is not None
    assert record.answer.startswith("3 maintenance issues are open")
    assert record.tools != []


async def test_a_refused_connection_is_an_adapter_failure(fake_target: RunningTarget) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    listener.close()
    adapter = SseAdapter(local_context(f"http://127.0.0.1:{port}", kind="sse"))
    try:
        record = await adapter.drive(stream("/anything"))
    finally:
        await adapter.close()
    assert record.ok is False
    assert record.response is None
    assert record.error is not None
    assert record.error.startswith("ConnectError")


async def test_cancelling_a_running_stream_propagates_and_releases_the_connection(
    fake_target: RunningTarget,
) -> None:
    adapter = SseAdapter(local_context(fake_target.base_url, kind="sse"))
    running = asyncio.create_task(adapter.drive(stream("/hang")))
    await asyncio.sleep(0.4)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    await adapter.close()


async def test_an_http_step_is_refused_by_the_sse_adapter(fake_target: RunningTarget) -> None:
    adapter = SseAdapter(local_context(fake_target.base_url, kind="sse"))
    http = HttpStep.model_validate({"adapter": "http", "request": {"method": "GET", "path": "/x"}})
    try:
        with pytest.raises(TypeError, match="http"):
            await adapter.drive(http)
    finally:
        await adapter.close()


async def test_the_bundle_chat_interface_streams_for_every_role(
    registered: RegisteredTarget,
) -> None:
    answers: dict[str, str | None] = {}
    for role in ("staff", "manager", "admin"):
        adapter = SseAdapter(registered.context(role, "chat_sse"))
        try:
            record = await adapter.drive(chat("Which rooms are dirty?"))
        finally:
            await adapter.close()
        assert record.ok is True
        answers[role] = record.answer
    assert set(answers.values()) == {"3 rooms are dirty: 20002, 20003, 20005."}
