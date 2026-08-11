import hashlib
import uuid
from types import SimpleNamespace
from typing import Any

import pytest

from tessa_api.auth.personal_tokens import (
    DISPLAY_PREFIX_LENGTH,
    TOKEN_PREFIX,
    hash_token,
    is_personal_token,
    mint_token,
)
from tessa_api.middleware import (
    ResponseFacts,
    route_template,
    should_record,
    written_resource_id,
)
from tessa_api.services.audit_context import AuditContext, AuthKind

USER = uuid.UUID("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11")
TOKEN = uuid.UUID("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e12")
TARGET = uuid.UUID("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e13")


def scope(method: str, path: str, route: str | None = None, **path_params: str) -> dict[str, Any]:
    built: dict[str, Any] = {"type": "http", "method": method, "path": path}
    if route is not None:
        built["route"] = SimpleNamespace(path=route)
        built["path_params"] = path_params
    return built


def personal() -> AuditContext:
    context = AuditContext()
    context.mark_personal(USER, TOKEN, None)
    return context


def session_context() -> AuditContext:
    context = AuditContext()
    context.mark_session(USER)
    return context


def facts(status: int = 201, replayed: bool = False, head: bytes = b"") -> ResponseFacts:
    return ResponseFacts(status=status, replayed=replayed, json=True, head=bytearray(head))


def test_a_minted_token_is_prefixed_hashed_with_sha256_and_never_repeats() -> None:
    first, second = mint_token(), mint_token()
    assert first.secret.startswith(TOKEN_PREFIX)
    assert "=" not in first.secret
    assert len(first.secret) == len(TOKEN_PREFIX) + 43
    assert first.token_hash == hashlib.sha256(first.secret.encode()).hexdigest()
    assert first.token_hash == hash_token(first.secret)
    assert first.prefix == first.secret[:DISPLAY_PREFIX_LENGTH]
    assert first.secret != second.secret
    assert is_personal_token(first.secret)
    assert not is_personal_token("eyJhbGciOiJIUzI1NiJ9.e30.sig")


def test_a_successful_write_with_a_personal_token_is_recorded() -> None:
    write = scope("POST", "/api/v1/runs", "/api/v1/runs")
    assert should_record(write, personal(), facts(202))
    for method in ("PUT", "PATCH", "DELETE"):
        assert should_record(scope(method, "/api/v1/runs", "/api/v1/runs"), personal(), facts(200))


@pytest.mark.parametrize(
    ("method", "status", "replayed"),
    [("GET", 200, False), ("POST", 422, False), ("POST", 500, False), ("POST", 202, True)],
)
def test_reads_failures_and_replays_are_not_recorded(
    method: str, status: int, replayed: bool
) -> None:
    request = scope(method, "/api/v1/runs", "/api/v1/runs")
    assert not should_record(request, personal(), facts(status, replayed))


def test_session_and_service_callers_are_not_recorded() -> None:
    request = scope("POST", "/api/v1/runs", "/api/v1/runs")
    service = AuditContext()
    service.mark_service()
    assert not should_record(request, session_context(), facts())
    assert not should_record(request, service, facts())
    assert not should_record(request, AuditContext(auth_kind=AuthKind.personal), facts())


@pytest.mark.parametrize(
    ("path", "route"),
    [
        ("/api/v1/agent-sessions", "/api/v1/agent-sessions"),
        (f"/api/v1/agent-sessions/{TARGET}", "/api/v1/agent-sessions/{agent_session_id}"),
        ("/api/v1/ws-tickets", "/api/v1/ws-tickets"),
        ("/api/v1/bundles/validate", "/api/v1/bundles/validate"),
        ("/api/v1/plans/preview", "/api/v1/plans/preview"),
        ("/api/v1/scenarios/validate", "/api/v1/scenarios/validate"),
    ],
)
def test_the_routes_that_store_nothing_are_not_recorded(path: str, route: str) -> None:
    request = scope("POST", path, route, agent_session_id=str(TARGET))
    assert not should_record(request, personal(), facts(200))


def test_the_route_template_replaces_the_values_of_path_parameters() -> None:
    request = scope(
        "PUT",
        f"/api/v1/targets/{TARGET}/proposal",
        "/api/v1/targets/{target_id}/proposal",
        target_id=str(TARGET),
    )
    assert route_template(request) == "/api/v1/targets/{target_id}/proposal"
    assert route_template(scope("POST", "/api/v1/unrouted")) == "/api/v1/unrouted"


def test_the_written_resource_comes_from_the_response_id_then_from_the_path() -> None:
    created = uuid.uuid4()
    body = f'{{"item": {{"name": "x"}}, "id": "{created}"}}'.encode()
    request = scope(
        "PATCH",
        f"/api/v1/targets/{TARGET}/x",
        "/api/v1/targets/{target_id}/x",
        target_id=str(TARGET),
    )
    assert written_resource_id(request, facts(head=body)) == created
    run_id = uuid.uuid4()
    assert written_resource_id(request, facts(head=f'{{"run_id":"{run_id}"}}'.encode())) == run_id
    assert written_resource_id(request, facts(head=b'{"ok": true}')) == TARGET
    assert written_resource_id(scope("POST", "/api/v1/runs"), facts(head=b"{}")) is None
