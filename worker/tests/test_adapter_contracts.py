import typing
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from tessa_api.schemas.enums import AdapterKind, ArtifactKind, HealthCheckStatus, Tier0Check
from tessa_api.schemas.health import HealthState
from tessa_api.schemas.scenario import (
    BrowserExpect,
    GraphqlExpect,
    HttpExpect,
    HttpStep,
    ScenarioDoc,
    ScenarioStep,
    SseExpect,
    WebsocketExpect,
)
from tessa_api.schemas.steps import (
    BrowserStepRequest,
    BrowserStepResponse,
    HttpStepRequest,
    HttpStepResponse,
    SseStepRequest,
    SseStepResponse,
    StepRequest,
    StepResponse,
    StepTool,
    Tier0Failure,
    Tier0Result,
)
from tessa_worker.adapters.base import (
    Adapter,
    ClockPinning,
    FlagSetting,
    ProducedArtifact,
    Resettable,
    StepRecord,
    TargetTrace,
)
from tessa_worker.checks.contracts import StepExpectations, Tier0Context, Tier0Evaluator

NOW = datetime(2026, 10, 5, 9, 0, 0, tzinfo=UTC)
LATER = datetime(2026, 10, 5, 9, 0, 1, tzinfo=UTC)

request_adapter: TypeAdapter[StepRequest] = TypeAdapter(StepRequest)
response_adapter: TypeAdapter[StepResponse] = TypeAdapter(StepResponse)

HTTP_REQUEST = HttpStepRequest(
    kind="http",
    method="GET",
    url="https://qa.example.test/api/rooms",
    headers={"Authorization": "Bearer ${ADMIN_TOKEN}"},
    query=None,
    body=None,
)
SSE_REQUEST = SseStepRequest(
    kind="sse",
    method="POST",
    url="https://qa.example.test/api/chat",
    headers={},
    query=None,
    body={"message": "hi"},
)
BROWSER_REQUEST = BrowserStepRequest(
    kind="browser", action="navigate", target=None, text=None, url="/login"
)
HTTP_RESPONSE = HttpStepResponse(
    kind="http", status=200, headers={}, body={"items": []}, body_text=None
)
SSE_RESPONSE = SseStepResponse(kind="sse", status=200, events=[], closed_by="server")
BROWSER_RESPONSE = BrowserStepResponse(
    kind="browser", url="/login", title=None, text_excerpt=None, console=[], dom_state=None
)


def record(**overrides: typing.Any) -> StepRecord:
    values: dict[str, typing.Any] = {
        "adapter": AdapterKind.http,
        "label": "GET /api/rooms",
        "request": HTTP_REQUEST,
        "response": HTTP_RESPONSE,
        "ok": True,
        "latency_ms": 12,
        "started_at": NOW,
        "finished_at": LATER,
    }
    values.update(overrides)
    return StepRecord.model_validate(values)


class FakeAdapter:
    kind = AdapterKind.http

    async def drive(self, step: ScenarioStep) -> StepRecord:
        return record()

    async def trace(self, trace_id: str) -> TargetTrace | None:
        return None

    async def health(self) -> HealthState:
        return HealthState(status=HealthCheckStatus.ok, checked_at=NOW, latency_ms=1, message=None)

    async def close(self) -> None:
        return None


class ClockedAdapter(FakeAdapter):
    async def pin_clock(self, at: datetime) -> None:
        return None

    async def set_flags(self, flags: Mapping[str, bool]) -> None:
        return None

    async def reset(self) -> None:
        return None


class NotAnAdapter:
    kind = AdapterKind.http

    async def drive(self, step: ScenarioStep) -> StepRecord:
        return record()


def passing_evaluator(
    step_record: StepRecord, expectations: StepExpectations, context: Tier0Context, /
) -> Tier0Result:
    return Tier0Result(passed=True, failures=[])


def failing_evaluator(
    record_: StepRecord, wanted: StepExpectations, ctx: Tier0Context, /
) -> Tier0Result:
    return Tier0Result(
        passed=False,
        failures=[Tier0Failure(check=Tier0Check.status, message="no", expected=200, actual=500)],
    )


def test_the_adapter_protocol_names_drive_trace_health_and_close() -> None:
    assert isinstance(FakeAdapter(), Adapter)
    assert not isinstance(NotAnAdapter(), Adapter)


def test_pin_clock_set_flags_and_reset_are_optional_capabilities() -> None:
    plain = FakeAdapter()
    assert not isinstance(plain, ClockPinning)
    assert not isinstance(plain, FlagSetting)
    assert not isinstance(plain, Resettable)
    capable = ClockedAdapter()
    assert isinstance(capable, Adapter)
    assert isinstance(capable, ClockPinning)
    assert isinstance(capable, FlagSetting)
    assert isinstance(capable, Resettable)


async def test_an_adapter_drives_a_scenario_step_into_a_step_record() -> None:
    document = ScenarioDoc.model_validate(
        {
            "schema_version": 1,
            "title": "Rooms",
            "family": "rooms",
            "role": "admin",
            "interface_id": "admin_api",
            "steps": [{"adapter": "http", "request": {"method": "GET", "path": "/api/rooms"}}],
        }
    )
    step = document.steps[0]
    assert isinstance(step, HttpStep)
    adapter: Adapter = FakeAdapter()
    produced = await adapter.drive(step)
    assert produced.adapter is AdapterKind.http
    assert (await adapter.health()).status is HealthCheckStatus.ok
    assert await adapter.trace("abc") is None


@pytest.mark.parametrize(
    ("adapter", "request_payload", "response_payload"),
    [
        (AdapterKind.http, HTTP_REQUEST, HTTP_RESPONSE),
        (AdapterKind.sse, SSE_REQUEST, SSE_RESPONSE),
        (AdapterKind.browser, BROWSER_REQUEST, BROWSER_RESPONSE),
    ],
)
def test_a_step_record_holds_the_request_and_response_unions_of_its_adapter(
    adapter: AdapterKind, request_payload: typing.Any, response_payload: typing.Any
) -> None:
    produced = record(adapter=adapter, request=request_payload, response=response_payload)
    assert produced.request.kind == adapter.value
    assert produced.response is not None
    assert produced.response.kind == adapter.value
    persisted_request = request_adapter.validate_python(produced.request.model_dump(mode="json"))
    persisted_response = response_adapter.validate_python(produced.response.model_dump(mode="json"))
    assert persisted_request.root == produced.request
    assert persisted_response.root == produced.response


def test_a_step_record_round_trips_through_json() -> None:
    produced = record(
        tools=[StepTool(name="search_documents", args={"q": "pets"}, result_summary=None)],
        cards=[{"kind": "confirmation"}],
        ask="hi",
        answer="hello",
        artifacts=[
            ProducedArtifact(kind=ArtifactKind.screenshot, mime="image/png", path=Path("a.png"))
        ],
    )
    assert StepRecord.model_validate_json(produced.model_dump_json()) == produced


def test_a_step_record_defaults_describe_a_plain_successful_step() -> None:
    produced = record()
    assert produced.response_truncated is False
    assert produced.error is None
    assert produced.ask is None
    assert produced.answer is None
    assert produced.tools == []
    assert produced.cards == []
    assert produced.artifacts == []
    assert produced.cost_usd == 0.0


def test_a_step_that_failed_to_act_has_no_response_and_says_why() -> None:
    produced = record(response=None, ok=False, error="ConnectError")
    assert produced.response is None
    assert produced.ok is False
    assert produced.error == "ConnectError"


def test_a_step_record_needs_timezone_aware_times_and_a_known_request_kind() -> None:
    with pytest.raises(ValidationError):
        record(started_at=datetime(2026, 10, 5, 9, 0, 0))
    with pytest.raises(ValidationError):
        record(request={"kind": "graphql", "method": "GET"})
    with pytest.raises(ValidationError):
        record(latency_ms=-1)


def test_the_step_record_serialises_times_the_api_way() -> None:
    produced = record()
    assert produced.model_dump(mode="json")["started_at"] == "2026-10-05T09:00:00.000Z"


def test_the_tier0_evaluator_protocol_takes_a_record_expectations_and_a_context() -> None:
    context = Tier0Context(internal_id_patterns=(r"\b[0-9a-f]{8}-[0-9a-f]{4}\b",))
    evaluators: list[Tier0Evaluator] = [passing_evaluator, failing_evaluator]
    results = [evaluator(record(), HttpExpect(), context) for evaluator in evaluators]
    assert [result.passed for result in results] == [True, False]
    assert results[1].failures[0].check is Tier0Check.status


def test_expectations_are_the_expect_models_of_every_step_kind_of_the_scenario_schema() -> None:
    assert set(typing.get_args(StepExpectations)) == {
        HttpExpect,
        SseExpect,
        BrowserExpect,
        WebsocketExpect,
        GraphqlExpect,
    }


def test_the_tier0_context_is_immutable_and_lists_patterns() -> None:
    context = Tier0Context(internal_id_patterns=("a", "b"))
    assert context.internal_id_patterns == ("a", "b")
    with pytest.raises(ValidationError):
        context.__setattr__("internal_id_patterns", ("c",))
    with pytest.raises(ValidationError):
        Tier0Context.model_validate({})


def test_a_produced_artifact_names_a_local_file_and_a_kind() -> None:
    artifact = ProducedArtifact(kind=ArtifactKind.trace, mime="application/zip", path=Path("t.zip"))
    assert artifact.path == Path("t.zip")
    assert artifact.kind is ArtifactKind.trace
