import json
import logging
import socket
from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Any

import pytest

from tessa_api.schemas.enums import AdapterKind, HealthCheckStatus
from tessa_api.schemas.scenario import HttpStep, SseStep
from tessa_api.schemas.steps import HttpStepRequest, HttpStepResponse
from tessa_worker.adapters.base import Adapter, StepRecord
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.http import HttpAdapter
from tests.adapters.support import RegisteredTarget, local_context
from tests.fake_target.dataset import (
    ADMIN_TOKEN,
    MANAGER_TOKEN,
    STAFF_EMAIL,
    STAFF_PASSWORD,
)
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


def step(
    path: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    query: dict[str, Any] | None = None,
    body: Any = None,
    expect: dict[str, Any] | None = None,
    identity: str | None = None,
    label: str | None = None,
) -> HttpStep:
    document: dict[str, Any] = {
        "adapter": "http",
        "request": {
            "method": method,
            "path": path,
            "headers": headers or {},
            "query": query or {},
            "body": body,
        },
        "expect": expect or {},
    }
    if identity is not None:
        document["as"] = identity
    if label is not None:
        document["label"] = label
    return HttpStep.model_validate(document)


def api_context(running: RunningTarget, role: str = "staff", **overrides: Any) -> AdapterContext:
    return local_context(
        running.base_url,
        base_path="/api",
        auth=BEARER_AUTH,
        values=CREDENTIALS,
        role=role,
        **overrides,
    )


@pytest.fixture
async def staff(fake_target: RunningTarget) -> AsyncIterator[HttpAdapter]:
    adapter = HttpAdapter(api_context(fake_target))
    yield adapter
    await adapter.close()


def response_of(record: StepRecord) -> HttpStepResponse:
    assert isinstance(record.response, HttpStepResponse)
    return record.response


def json_body(record: StepRecord) -> dict[str, Any]:
    body = response_of(record).body
    assert isinstance(body, dict)
    return body


def persisted(record: StepRecord) -> str:
    return record.model_dump_json()


def received_authorizations(running: RunningTarget, path: str) -> list[str | None]:
    return [
        request.headers.get("authorization")
        for request in running.state.requests
        if request.path == path
    ]


def test_the_adapter_satisfies_the_protocol_and_reports_its_kind(
    fake_target: RunningTarget,
) -> None:
    adapter = HttpAdapter(api_context(fake_target))
    assert isinstance(adapter, Adapter)
    assert adapter.kind is AdapterKind.http


async def test_a_step_returns_the_parsed_json_body_status_and_latency(
    staff: HttpAdapter,
) -> None:
    record = await staff.drive(step("/rooms", query={"status": "dirty"}))
    response = response_of(record)
    assert record.adapter is AdapterKind.http
    assert record.ok is True
    assert record.error is None
    assert response.status == 200
    body = json_body(record)
    assert body["total"] == 3
    assert [item["number"] for item in body["items"]] == ["20002", "20003", "20005"]
    assert response.body_text is None
    assert response.headers["content-type"] == "application/json"
    assert record.response_truncated is False
    assert record.latency_ms >= 0
    assert record.finished_at >= record.started_at


async def test_the_request_is_persisted_as_the_http_step_request(staff: HttpAdapter) -> None:
    record = await staff.drive(
        step("/rooms", query={"status": "dirty", "ids": [1, 2], "all": True})
    )
    request = record.request
    assert isinstance(request, HttpStepRequest)
    assert request.kind == "http"
    assert request.method == "GET"
    assert request.url.endswith("/api/rooms")
    assert request.query == {"status": "dirty", "ids": [1, 2], "all": True}
    assert request.body is None
    assert record.label == "GET /rooms"


async def test_a_label_in_the_scenario_wins_over_the_derived_one(staff: HttpAdapter) -> None:
    record = await staff.drive(step("/rooms", label="List the dirty rooms"))
    assert record.label == "List the dirty rooms"


async def test_the_staff_login_runs_once_and_the_session_token_is_never_persisted(
    fake_target: RunningTarget, staff: HttpAdapter
) -> None:
    first = await staff.drive(step("/rooms"))
    second = await staff.drive(step("/me"))
    assert response_of(first).status == 200
    assert response_of(second).body == {"role": "staff"}
    logins = [r for r in fake_target.state.requests if r.path == "/api/auth/login"]
    assert len(logins) == 1
    sent = received_authorizations(fake_target, "/api/rooms")[0]
    assert sent is not None
    token = sent.removeprefix("Bearer ")
    assert token.startswith("fake-session-")
    for record in (first, second):
        assert token not in persisted(record)
        assert STAFF_PASSWORD not in persisted(record)
    assert isinstance(first.request, HttpStepRequest)
    assert first.request.headers["Authorization"] == "Bearer ${STAFF_SESSION_TOKEN}"


async def test_a_static_token_role_sends_the_vault_value_and_persists_the_placeholder(
    fake_target: RunningTarget,
) -> None:
    adapter = HttpAdapter(api_context(fake_target, role="manager"))
    try:
        record = await adapter.drive(step("/me"))
    finally:
        await adapter.close()
    assert response_of(record).body == {"role": "manager"}
    assert received_authorizations(fake_target, "/api/me") == [f"Bearer {MANAGER_TOKEN}"]
    assert MANAGER_TOKEN not in persisted(record)
    assert isinstance(record.request, HttpStepRequest)
    assert record.request.headers["Authorization"] == "Bearer ${MANAGER_TOKEN}"


async def test_the_anonymous_identity_gets_a_401_and_no_credentials_are_sent(
    fake_target: RunningTarget, staff: HttpAdapter
) -> None:
    record = await staff.drive(step("/rooms", identity="anonymous"))
    assert response_of(record).status == 401
    assert record.ok is True
    assert received_authorizations(fake_target, "/api/rooms") == [None]
    assert isinstance(record.request, HttpStepRequest)
    assert "Authorization" not in record.request.headers


async def test_a_step_can_run_as_another_role_with_its_own_credentials(
    staff: HttpAdapter,
) -> None:
    as_staff = await staff.drive(step("/admin/users"))
    as_admin = await staff.drive(step("/admin/users", identity="admin"))
    assert response_of(as_staff).status == 403
    assert response_of(as_admin).status == 200
    assert response_of(as_admin).body == {
        "items": [
            {"email": "staff@fake.test", "role": "staff"},
            {"email": "manager@fake.test", "role": "manager"},
            {"email": "admin@fake.test", "role": "admin"},
        ],
        "total": 3,
    }
    assert ADMIN_TOKEN not in persisted(as_admin)


async def test_a_json_body_is_sent_and_secrets_in_every_part_are_redacted(
    fake_target: RunningTarget,
) -> None:
    context = local_context(
        fake_target.base_url, values={"ADMIN_TOKEN": ADMIN_TOKEN}, base_path="/qa"
    )
    adapter = HttpAdapter(context)
    try:
        record = await adapter.drive(
            step(
                "/echo?token=${ADMIN_TOKEN}",
                method="POST",
                headers={"X-Api-Key": "${ADMIN_TOKEN}"},
                query={"q": "${ADMIN_TOKEN}"},
                body={"note": "use ${ADMIN_TOKEN} please", "nested": ["${ADMIN_TOKEN}"]},
            )
        )
    finally:
        await adapter.close()
    assert record.ok is True
    assert ADMIN_TOKEN not in persisted(record)
    request = record.request
    assert isinstance(request, HttpStepRequest)
    assert request.url.endswith("/qa/echo?token=${ADMIN_TOKEN}")
    assert request.headers["X-Api-Key"] == "${ADMIN_TOKEN}"
    assert request.query == {"q": "${ADMIN_TOKEN}"}
    assert request.body == {"note": "use ${ADMIN_TOKEN} please", "nested": ["${ADMIN_TOKEN}"]}
    body = json_body(record)
    assert body["query"] == {"token": "${ADMIN_TOKEN}", "q": "${ADMIN_TOKEN}"}
    assert "${ADMIN_TOKEN}" in body["body"]
    received = next(r for r in fake_target.state.requests if r.path == "/qa/echo")
    assert received.headers["x-api-key"] == ADMIN_TOKEN
    assert received.headers["content-type"] == "application/json"


async def test_a_secret_echoed_by_the_target_is_redacted_in_the_response(
    fake_target: RunningTarget,
) -> None:
    adapter = HttpAdapter(
        local_context(
            fake_target.base_url,
            auth={"type": "bearer", "token_source": {"staff": "${ADMIN_TOKEN}"}},
            values={"ADMIN_TOKEN": ADMIN_TOKEN},
        )
    )
    try:
        record = await adapter.drive(step("/echo"))
    finally:
        await adapter.close()
    assert json_body(record)["authorization"] == "Bearer ${ADMIN_TOKEN}"
    assert ADMIN_TOKEN not in persisted(record)


async def test_non_json_text_is_kept_as_body_text(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url))
    try:
        record = await adapter.drive(step("/text"))
    finally:
        await adapter.close()
    response = response_of(record)
    assert response.body is None
    assert response.body_text == "plain text body"
    assert response.headers["content-type"].startswith("text/plain")


async def test_an_error_status_is_recorded_not_raised(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url))
    try:
        record = await adapter.drive(step("/status/500"))
    finally:
        await adapter.close()
    assert record.ok is True
    assert response_of(record).status == 500
    assert response_of(record).body == {"code": 500}


async def test_an_empty_body_has_neither_body_nor_body_text(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url))
    try:
        record = await adapter.drive(step("/empty"))
    finally:
        await adapter.close()
    response = response_of(record)
    assert response.status == 204
    assert response.body is None
    assert response.body_text is None


async def test_a_redirect_is_recorded_and_not_followed(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url, base_path=""))
    try:
        record = await adapter.drive(step("/chat"))
    finally:
        await adapter.close()
    response = response_of(record)
    assert response.status == 302
    assert response.headers["location"] == "/login"


async def test_a_large_body_is_truncated_and_flagged(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url, max_payload_bytes=2048))
    try:
        record = await adapter.drive(step("/big", query={"kb": 64}))
    finally:
        await adapter.close()
    response = response_of(record)
    assert record.ok is True
    assert record.response_truncated is True
    assert response.status == 200
    assert response.body is None
    assert response.body_text is not None
    assert len(response.body_text.encode()) <= 2048
    assert response.body_text.startswith('{"items":[],"payload":"xxx')
    assert len(record.model_dump_json()) < 4096 * 2


async def test_a_body_just_under_the_limit_is_kept_whole(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url, max_payload_bytes=4096))
    try:
        record = await adapter.drive(step("/big", query={"kb": 1}))
    finally:
        await adapter.close()
    assert record.response_truncated is False
    assert isinstance(response_of(record).body, dict)


async def test_a_large_request_body_is_truncated_in_the_record_only(
    fake_target: RunningTarget,
) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url, max_payload_bytes=512))
    try:
        record = await adapter.drive(step("/echo", method="POST", body={"data": "y" * 5000}))
    finally:
        await adapter.close()
    assert isinstance(record.request, HttpStepRequest)
    assert isinstance(record.request.body, str)
    assert len(record.request.body.encode()) <= 512
    assert record.response_truncated is True
    echoed = [r for r in fake_target.state.requests if r.path == "/qa/echo"]
    assert len(echoed) == 1


async def test_a_secret_cut_by_the_read_limit_leaves_no_fragment_behind(
    fake_target: RunningTarget,
) -> None:
    secret = "zq9-secret-VALUE-12345"
    cap = 1000
    adapter = HttpAdapter(
        local_context(fake_target.base_url, values={"PROBE_TOKEN": secret}, max_payload_bytes=cap)
    )
    try:
        read_limit = cap + adapter.context.redactor.max_secret_length + 1
        truncated = 0
        for padding in range(read_limit - 260, read_limit + 60):
            body = {"data": "a" * padding + secret}
            record = await adapter.drive(step("/echo", method="POST", body=body))
            stored = persisted(record)
            for length in range(3, len(secret) + 1):
                assert secret[:length] not in stored
            truncated += record.response_truncated
        assert truncated > 100
    finally:
        await adapter.close()


async def test_a_timeout_is_an_adapter_failure_with_no_response(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url, step_timeout_seconds=0.3))
    try:
        record = await adapter.drive(step("/slow", query={"ms": 3000}))
    finally:
        await adapter.close()
    assert record.ok is False
    assert record.response is None
    assert record.error == "timed out after 0.3s"
    assert 250 <= record.latency_ms < 2000


async def test_latency_is_measured_around_the_whole_exchange(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url))
    try:
        record = await adapter.drive(step("/slow", query={"ms": 300}))
    finally:
        await adapter.close()
    assert record.ok is True
    assert 250 <= record.latency_ms < 3000


async def test_a_refused_connection_is_an_adapter_failure_named_by_type() -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    listener.close()
    adapter = HttpAdapter(local_context(f"http://127.0.0.1:{port}"))
    try:
        record = await adapter.drive(step("/anything"))
    finally:
        await adapter.close()
    assert record.ok is False
    assert record.response is None
    assert record.error is not None
    assert record.error.startswith("ConnectError")


async def test_a_missing_placeholder_value_fails_the_step_and_keeps_the_raw_request(
    fake_target: RunningTarget,
) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url))
    try:
        record = await adapter.drive(step("/echo", headers={"X-Token": "${NOT_SET}"}))
    finally:
        await adapter.close()
    assert record.ok is False
    assert record.error == "no value is set for ${NOT_SET}"
    assert isinstance(record.request, HttpStepRequest)
    assert record.request.headers == {"Accept": "application/json", "X-Token": "${NOT_SET}"}
    assert [r for r in fake_target.state.requests if r.path == "/qa/echo"] == []


async def test_a_failed_login_fails_every_step_without_hammering_the_target(
    fake_target: RunningTarget,
) -> None:
    values = dict(CREDENTIALS) | {"STAFF_PASSWORD": "wrong-password-123"}
    adapter = HttpAdapter(
        local_context(fake_target.base_url, base_path="/api", auth=BEARER_AUTH, values=values)
    )
    try:
        first = await adapter.drive(step("/rooms"))
        second = await adapter.drive(step("/rooms"))
    finally:
        await adapter.close()
    assert first.ok is False
    assert first.error == "login answered HTTP 401"
    assert second.ok is False
    assert second.error == "login answered HTTP 401"
    assert len([r for r in fake_target.state.requests if r.path == "/api/auth/login"]) == 1
    assert [r for r in fake_target.state.requests if r.path == "/api/rooms"] == []
    assert "wrong-password-123" not in persisted(first)


async def test_a_role_without_credentials_fails_the_step_with_a_reason(
    fake_target: RunningTarget,
) -> None:
    adapter = HttpAdapter(
        local_context(
            fake_target.base_url,
            auth={"type": "bearer", "token_source": {"admin": "${ADMIN_TOKEN}"}},
            values={"ADMIN_TOKEN": ADMIN_TOKEN},
            role="manager",
        )
    )
    try:
        record = await adapter.drive(step("/rooms"))
    finally:
        await adapter.close()
    assert record.ok is False
    assert record.error is not None
    assert "manager" in record.error


async def test_a_cookie_session_is_kept_and_the_cookie_value_is_redacted(
    fake_target: RunningTarget,
) -> None:
    adapter = HttpAdapter(
        local_context(
            fake_target.base_url,
            base_path="/api",
            auth={"type": "cookie", "token_source": {"staff": LOGIN}},
            values=CREDENTIALS,
        )
    )
    try:
        record = await adapter.drive(step("/me"))
        again = await adapter.drive(step("/me"))
    finally:
        await adapter.close()
    assert response_of(record).body == {"role": "staff"}
    assert response_of(again).body == {"role": "staff"}
    cookies = [r.headers.get("cookie") for r in fake_target.state.requests if r.path == "/api/me"]
    assert all(cookie and cookie.startswith("fake_session=fake-session-") for cookie in cookies)
    session_value = (cookies[0] or "").split("=", 1)[1]
    assert session_value not in persisted(record)


async def test_a_login_that_returns_no_token_and_no_cookie_is_an_error(
    fake_target: RunningTarget,
) -> None:
    adapter = HttpAdapter(
        local_context(
            fake_target.base_url,
            auth={"type": "bearer", "token_source": {"staff": "GET /health"}},
        )
    )
    try:
        record = await adapter.drive(step("/echo"))
    finally:
        await adapter.close()
    assert record.ok is False
    assert record.error == "login returned no token and set no cookie"


async def test_an_sse_step_is_refused_by_the_http_adapter(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url))
    sse = SseStep.model_validate(
        {"adapter": "sse", "request": {"method": "POST", "path": "/x", "body": {}}}
    )
    try:
        with pytest.raises(TypeError, match="sse"):
            await adapter.drive(sse)
    finally:
        await adapter.close()


async def test_health_reports_ok_failed_and_skipped(fake_target: RunningTarget) -> None:
    healthy = HttpAdapter(local_context(fake_target.base_url))
    assert (await healthy.health()).status is HealthCheckStatus.ok
    gone = HttpAdapter(local_context("http://127.0.0.1:9", step_timeout_seconds=1.0))
    failed = await gone.health()
    assert failed.status is HealthCheckStatus.failed
    assert failed.message is not None
    context = healthy.context
    silent = replace(context, interface=replace(context.interface, health_url=None))
    assert (await HttpAdapter(silent).health()).status is HealthCheckStatus.skipped


async def test_trace_is_not_supported_and_close_can_be_repeated(fake_target: RunningTarget) -> None:
    adapter = HttpAdapter(local_context(fake_target.base_url))
    assert await adapter.trace("anything") is None
    await adapter.close()
    await adapter.close()


async def test_a_new_login_session_is_made_for_each_identity(
    fake_target: RunningTarget, staff: HttpAdapter
) -> None:
    await staff.drive(step("/rooms"))
    await staff.drive(step("/rooms", identity="manager"))
    await staff.drive(step("/rooms", identity="staff"))
    await staff.drive(step("/rooms", identity="anonymous"))
    received = received_authorizations(fake_target, "/api/rooms")
    assert received[0] is not None
    assert received[0].startswith("Bearer fake-session-")
    assert received[1] == f"Bearer {MANAGER_TOKEN}"
    assert received[2] == received[0]
    assert received[3] is None
    assert len([r for r in fake_target.state.requests if r.path == "/api/auth/login"]) == 1


async def test_the_bundle_interfaces_resolve_and_drive_against_the_fake_target(
    registered: RegisteredTarget,
) -> None:
    context = registered.context("admin", "api")
    adapter = HttpAdapter(context)
    try:
        record = await adapter.drive(step("/admin/users"))
        rooms = await adapter.drive(step("/rooms", query={"status": "clean"}))
    finally:
        await adapter.close()
    assert response_of(record).status == 200
    assert response_of(rooms).status == 200
    assert json.loads(persisted(record))["request"]["headers"]["Authorization"] == (
        "Bearer ${ADMIN_TOKEN}"
    )


async def test_request_urls_with_secrets_never_reach_the_client_library_logs(
    fake_target: RunningTarget, caplog: pytest.LogCaptureFixture
) -> None:
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.NOTSET)
    caplog.set_level(logging.DEBUG)
    adapter = HttpAdapter(local_context(fake_target.base_url, values={"ADMIN_TOKEN": ADMIN_TOKEN}))
    try:
        record = await adapter.drive(step("/echo", query={"token": "${ADMIN_TOKEN}"}))
    finally:
        await adapter.close()
    assert record.ok is True
    assert [r for r in caplog.records if r.name in ("httpx", "httpcore")] == []
    assert ADMIN_TOKEN not in caplog.text
