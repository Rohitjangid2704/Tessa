import json
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import AdapterKind, Tier0Check
from tessa_api.schemas.steps import (
    BrowserStepRequest,
    BrowserStepResponse,
    DomStateObservation,
    HttpStepRequest,
    HttpStepResponse,
    SseStepRequest,
    SseStepResponse,
    Step,
    StepRequest,
    StepRequestUnion,
    StepResponse,
    StepResponseUnion,
    StepSummary,
    Tier0Failure,
    Tier0Result,
)

STEP_ID = "0198f6f2-8a11-7c33-8e02-19d0a5a7c9b4"
RUN_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11"
RUN_SCENARIO_ID = "0198f6f2-7b00-7a00-9d00-000000000001"
ARTIFACT_ID = "0198f6f2-9c00-7b00-8d00-0000000000a1"

HTTP_REQUEST = {
    "kind": "http",
    "method": "GET",
    "url": "https://qa.example.test/api/rooms",
    "headers": {"Authorization": "Bearer ${ADMIN_TOKEN}"},
    "query": {"limit": 5},
    "body": None,
}
SSE_REQUEST = {**HTTP_REQUEST, "kind": "sse", "method": "POST", "body": {"message": "hi"}}
BROWSER_REQUEST = {
    "kind": "browser",
    "action": "click",
    "target": "role=button name=Send",
    "text": None,
    "url": None,
}
HTTP_RESPONSE = {
    "kind": "http",
    "status": 200,
    "headers": {"content-type": "application/json"},
    "body": {"items": [], "total": 0},
    "body_text": None,
}
SSE_RESPONSE = {
    "kind": "sse",
    "status": 200,
    "events": [
        {"event": None, "data": "hello", "at_ms": 12},
        {"event": "done", "data": "{}", "at_ms": 480},
    ],
    "closed_by": "server",
}
BROWSER_RESPONSE = {
    "kind": "browser",
    "url": "https://qa.example.test/",
    "title": "Smart Log",
    "text_excerpt": "Open issues: 3",
    "console": [{"level": "error", "text": "boom"}],
    "dom_state": {"text_found": {"Open": True}, "elements": {"role=button name=Send": "visible"}},
}

request_adapter: TypeAdapter[StepRequest] = TypeAdapter(StepRequest)
response_adapter: TypeAdapter[StepResponse] = TypeAdapter(StepResponse)
request_union_adapter: TypeAdapter[StepRequestUnion] = TypeAdapter(StepRequestUnion)
response_union_adapter: TypeAdapter[StepResponseUnion] = TypeAdapter(StepResponseUnion)


def step_document(**overrides: Any) -> dict[str, Any]:
    document: dict[str, Any] = {
        "id": STEP_ID,
        "run_id": RUN_ID,
        "run_scenario_id": RUN_SCENARIO_ID,
        "attempt": 0,
        "index": 3,
        "adapter": "http",
        "label": "GET /api/rooms",
        "request": HTTP_REQUEST,
        "response": HTTP_RESPONSE,
        "response_truncated": False,
        "payload_purged": False,
        "ask": None,
        "answer": None,
        "tools": [{"name": "search_documents", "args": {"q": "pets"}, "result_summary": None}],
        "cards": [{"kind": "confirmation"}],
        "latency_ms": 412,
        "cost_usd": 0.0,
        "tier0": {"passed": True, "failures": []},
        "artifacts": [
            {
                "id": ARTIFACT_ID,
                "kind": "screenshot",
                "mime": "image/png",
                "size_bytes": 1234,
                "url": f"/api/v1/artifacts/{ARTIFACT_ID}.1790000000.abcdef",
                "expires_at": "2026-10-05T10:00:00.000Z",
            }
        ],
        "verdict": None,
        "gold_points": [],
        "db_checks": [],
        "probes": [],
        "judge": None,
        "evidence": None,
        "started_at": "2026-10-05T09:00:00.000Z",
        "finished_at": "2026-10-05T09:00:00.412Z",
    }
    document.update(overrides)
    return document


@pytest.mark.parametrize(
    ("payload", "expected_type"),
    [
        (HTTP_REQUEST, HttpStepRequest),
        (SSE_REQUEST, SseStepRequest),
        (BROWSER_REQUEST, BrowserStepRequest),
    ],
)
def test_a_step_request_picks_its_shape_from_the_inner_kind(
    payload: dict[str, Any], expected_type: type
) -> None:
    assert isinstance(request_union_adapter.validate_python(payload), expected_type)
    assert isinstance(request_adapter.validate_python(payload).root, expected_type)


@pytest.mark.parametrize(
    ("payload", "expected_type"),
    [
        (HTTP_RESPONSE, HttpStepResponse),
        (SSE_RESPONSE, SseStepResponse),
        (BROWSER_RESPONSE, BrowserStepResponse),
    ],
)
def test_a_step_response_picks_its_shape_from_the_inner_kind(
    payload: dict[str, Any], expected_type: type
) -> None:
    assert isinstance(response_union_adapter.validate_python(payload), expected_type)
    assert isinstance(response_adapter.validate_python(payload).root, expected_type)


@pytest.mark.parametrize("payload", [HTTP_REQUEST, SSE_REQUEST, BROWSER_REQUEST])
def test_a_request_round_trips_through_json(payload: dict[str, Any]) -> None:
    parsed = request_adapter.validate_python(payload)
    dumped = json.loads(request_adapter.dump_json(parsed))
    assert dumped == payload
    assert request_adapter.validate_python(dumped) == parsed


@pytest.mark.parametrize("payload", [HTTP_RESPONSE, SSE_RESPONSE, BROWSER_RESPONSE])
def test_a_response_round_trips_through_json(payload: dict[str, Any]) -> None:
    parsed = response_adapter.validate_python(payload)
    dumped = json.loads(response_adapter.dump_json(parsed))
    assert dumped == payload
    assert response_adapter.validate_python(dumped) == parsed


def test_an_unknown_or_missing_kind_is_rejected() -> None:
    for payload in ({**HTTP_REQUEST, "kind": "graphql"}, {"method": "GET"}):
        with pytest.raises(ValidationError):
            request_adapter.validate_python(payload)
    with pytest.raises(ValidationError):
        response_adapter.validate_python({**HTTP_RESPONSE, "kind": "cli"})


def test_a_payload_of_the_wrong_shape_for_its_kind_is_rejected() -> None:
    with pytest.raises(ValidationError):
        request_adapter.validate_python({**HTTP_REQUEST, "kind": "browser"})
    with pytest.raises(ValidationError):
        response_adapter.validate_python({**SSE_RESPONSE, "closed_by": "nobody"})
    with pytest.raises(ValidationError):
        request_adapter.validate_python({**BROWSER_REQUEST, "action": "scroll"})


def test_unknown_extra_keys_are_kept_and_never_break_a_client() -> None:
    parsed = request_adapter.validate_python({**HTTP_REQUEST, "http_version": "2"})
    assert json.loads(request_adapter.dump_json(parsed))["http_version"] == "2"
    parsed_response = response_adapter.validate_python({**SSE_RESPONSE, "retry_ms": 1000})
    assert json.loads(response_adapter.dump_json(parsed_response))["retry_ms"] == 1000


def test_the_browser_dom_state_is_a_typed_observation() -> None:
    parsed = response_adapter.validate_python(BROWSER_RESPONSE).root
    assert isinstance(parsed, BrowserStepResponse)
    assert isinstance(parsed.dom_state, DomStateObservation)
    assert parsed.dom_state.elements == {"role=button name=Send": "visible"}
    with pytest.raises(ValidationError):
        response_adapter.validate_python(
            {**BROWSER_RESPONSE, "dom_state": {"text_found": {}, "elements": {"a": "gone"}}}
        )


def test_a_step_validates_and_dumps_the_contract_fields() -> None:
    step = Step.model_validate(step_document())
    dumped = step.model_dump(mode="json")
    assert set(dumped) == {
        "id",
        "run_id",
        "run_scenario_id",
        "attempt",
        "index",
        "adapter",
        "label",
        "request",
        "response",
        "response_truncated",
        "payload_purged",
        "ask",
        "answer",
        "tools",
        "cards",
        "latency_ms",
        "cost_usd",
        "tier0",
        "artifacts",
        "verdict",
        "gold_points",
        "db_checks",
        "probes",
        "judge",
        "evidence",
        "started_at",
        "finished_at",
    }
    assert dumped["request"] == HTTP_REQUEST
    assert dumped["response"] == HTTP_RESPONSE
    assert dumped["started_at"] == "2026-10-05T09:00:00.000Z"
    assert dumped["artifacts"][0]["expires_at"] == "2026-10-05T10:00:00.000Z"


def test_a_step_keeps_nullable_fields_present() -> None:
    step = Step.model_validate(step_document(request=None, response=None, payload_purged=True))
    dumped = step.model_dump(mode="json")
    assert dumped["request"] is None
    assert dumped["response"] is None
    assert dumped["payload_purged"] is True
    assert dumped["verdict"] is None
    assert dumped["ask"] is None


@pytest.mark.parametrize(
    ("adapter", "request_payload", "response_payload"),
    [
        ("sse", SSE_REQUEST, SSE_RESPONSE),
        ("browser", BROWSER_REQUEST, BROWSER_RESPONSE),
    ],
)
def test_a_step_of_each_adapter_round_trips(
    adapter: str, request_payload: dict[str, Any], response_payload: dict[str, Any]
) -> None:
    document = step_document(adapter=adapter, request=request_payload, response=response_payload)
    step = Step.model_validate(document)
    assert step.adapter == AdapterKind(adapter)
    assert step.request is not None
    assert step.request.root.kind == adapter
    assert Step.model_validate_json(step.model_dump_json()) == step


def test_a_step_with_the_unknown_extra_key_in_its_payload_still_parses() -> None:
    document = step_document(request={**HTTP_REQUEST, "future_key": [1, 2]})
    assert Step.model_validate(document).request is not None


def test_a_step_rejects_a_request_of_an_unknown_kind() -> None:
    with pytest.raises(ValidationError):
        Step.model_validate(step_document(request={**HTTP_REQUEST, "kind": "pipeline"}))


def test_step_summary_is_the_step_recorded_payload_plus_the_verdict() -> None:
    summary = StepSummary.model_validate(
        {
            "id": STEP_ID,
            "index": 3,
            "attempt": 0,
            "adapter": "browser",
            "label": "click Send",
            "ok": True,
            "latency_ms": 412,
            "cost_usd": 0.0,
            "tier0_failure_count": 0,
            "screenshot_count": 1,
            "verdict": {
                "status": "pass",
                "tier": "code",
                "confidence": 1.0,
                "reason_code": None,
                "reason": None,
                "skip_reason": None,
            },
        }
    )
    assert isinstance(summary.verdict, Verdict)
    assert set(StepSummary.model_fields) == {
        "id",
        "index",
        "attempt",
        "adapter",
        "label",
        "ok",
        "latency_ms",
        "cost_usd",
        "tier0_failure_count",
        "screenshot_count",
        "verdict",
    }


def test_tier0_names_every_contract_check() -> None:
    assert [check.value for check in Tier0Check] == [
        "status",
        "schema",
        "fields",
        "latency",
        "tools",
        "cards",
        "internal_ids",
        "text_contains",
        "text_not_contains",
        "console",
        "dom_state",
    ]


def test_a_tier0_failure_carries_expected_and_actual_as_any_json() -> None:
    result = Tier0Result(
        passed=False,
        failures=[
            Tier0Failure(
                check=Tier0Check.status,
                message="status 500 is not accepted",
                expected=[200, 201],
                actual=500,
            ),
            Tier0Failure(
                check=Tier0Check.fields,
                message="items is missing",
                expected={"path": "items", "exists": True},
                actual=None,
            ),
        ],
    )
    dumped = json.loads(result.model_dump_json())
    assert dumped["failures"][0]["expected"] == [200, 201]
    assert dumped["failures"][1]["actual"] is None
    assert Tier0Result.model_validate(dumped) == result


def test_a_verdict_confidence_is_a_probability() -> None:
    base = {
        "status": "pass",
        "tier": "code",
        "reason_code": None,
        "reason": None,
        "skip_reason": None,
    }
    Verdict.model_validate({**base, "confidence": None})
    Verdict.model_validate({**base, "confidence": 0.5})
    with pytest.raises(ValidationError):
        Verdict.model_validate({**base, "confidence": 1.5})
    with pytest.raises(ValidationError):
        Verdict.model_validate({"status": "pass", "tier": "code"})
