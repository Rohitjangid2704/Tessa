import json
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from tessa_api.schemas.enums import FeedName
from tessa_api.schemas.events import (
    EVENT_FEEDS,
    TILE_FPS_CEILING,
    TILE_MAX_UNACKED_FRAMES,
    TILE_QUALITY_CEILING,
    TILE_QUALITY_FLOOR,
    TILE_WIDTH_CEILING,
    TileDemandMessage,
    feeds_for,
)
from tessa_api.schemas.streams import (
    BrowserSessionEndedEvent,
    BrowserSessionStartedEvent,
    BudgetExhaustedEvent,
    BudgetUpdatedEvent,
    RunProgressEvent,
    ScenarioFinishedEvent,
    ScenarioQueuedEvent,
    ScenarioStartedEvent,
    ScenarioVerdictEvent,
    StepRecordedEvent,
    TileFrameEvent,
    stream_client_message_adapter,
    stream_event_adapter,
)
from tessa_api.services.schema_registry import build_stream_event_schema
from tests.test_schema_publisher import STREAM_EVENT_TYPES

RUN_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11"
RUN_SCENARIO_ID = "0198f6f2-7b00-7a00-9d00-000000000001"
SCENARIO_ID = "0198f6f2-7b00-7a00-9d00-000000000002"
STEP_ID = "0198f6f2-8a11-7c33-8e02-19d0a5a7c9b4"
SESSION_ID = "0198f6f2-9d00-7a00-9d00-0000000000b1"
TS = "2026-10-05T09:00:00.123Z"
VERDICT = {
    "status": "pass",
    "tier": "code",
    "confidence": None,
    "reason_code": None,
    "reason": None,
    "skip_reason": None,
}
COUNTERS = {
    "scenarios_total": 4,
    "scenarios_done": 1,
    "pass": 1,
    "fail": 0,
    "flaky": 0,
    "uncertain": 0,
    "skipped": 0,
    "steps_recorded": 6,
}

STAGE_TWO_EVENTS: dict[str, tuple[type, dict[str, Any]]] = {
    "run.progress": (RunProgressEvent, COUNTERS),
    "budget.updated": (
        BudgetUpdatedEvent,
        {"max_usd": 5.0, "spent_usd": 0.0, "max_minutes": 30, "elapsed_ms": 4000},
    ),
    "budget.exhausted": (
        BudgetExhaustedEvent,
        {"dimension": "minutes", "limit": 30.0, "actual": 30.4},
    ),
    "scenario.queued": (
        ScenarioQueuedEvent,
        {
            "run_scenario_id": RUN_SCENARIO_ID,
            "scenario_id": SCENARIO_ID,
            "title": "Staff asks about open maintenance",
            "role": "staff",
            "interface_id": "chat_sse",
            "attempts_total": 3,
        },
    ),
    "scenario.started": (ScenarioStartedEvent, {"run_scenario_id": RUN_SCENARIO_ID, "attempt": 0}),
    "scenario.verdict": (
        ScenarioVerdictEvent,
        {"run_scenario_id": RUN_SCENARIO_ID, "attempt": 1, "verdict": VERDICT},
    ),
    "scenario.finished": (
        ScenarioFinishedEvent,
        {
            "run_scenario_id": RUN_SCENARIO_ID,
            "status": "finished",
            "verdict": VERDICT,
            "attempts": {"passed": 3, "failed": 0, "total": 3},
            "duration_ms": 9100,
        },
    ),
    "step.recorded": (
        StepRecordedEvent,
        {
            "step_id": STEP_ID,
            "run_scenario_id": RUN_SCENARIO_ID,
            "attempt": 0,
            "index": 3,
            "adapter": "browser",
            "label": "click Send",
            "ok": True,
            "latency_ms": 412,
            "cost_usd": 0.0,
            "tier0_failure_count": 0,
            "screenshot_count": 1,
        },
    ),
    "browser_session.started": (
        BrowserSessionStartedEvent,
        {
            "browser_session_id": SESSION_ID,
            "run_scenario_id": RUN_SCENARIO_ID,
            "attempt": 0,
            "viewport": {"width": 1280, "height": 720},
            "scenario_title": "Staff signs in",
            "started_at": TS,
        },
    ),
    "browser_session.ended": (
        BrowserSessionEndedEvent,
        {
            "browser_session_id": SESSION_ID,
            "run_scenario_id": RUN_SCENARIO_ID,
            "has_recording": True,
            "has_trace": True,
            "ended_at": TS,
        },
    ),
    "tile.frame": (
        TileFrameEvent,
        {
            "browser_session_id": SESSION_ID,
            "frame_seq": 7,
            "mime": "image/jpeg",
            "width": 640,
            "height": 360,
            "data_b64": "/9j/4AAQ",
            "page_url": "https://qa.example.test/",
            "captured_at": TS,
        },
    ),
}


def envelope(event_type: str, payload: dict[str, Any], seq: int | None = 5) -> dict[str, Any]:
    return {"type": event_type, "run_id": RUN_ID, "seq": seq, "ts": TS, "payload": payload}


@pytest.mark.parametrize("event_type", sorted(STAGE_TWO_EVENTS))
def test_every_stage_two_event_validates_into_its_own_model(event_type: str) -> None:
    model, payload = STAGE_TWO_EVENTS[event_type]
    seq = None if event_type == "tile.frame" else 5
    parsed = stream_event_adapter.validate_python(envelope(event_type, payload, seq))
    assert isinstance(parsed, model)
    dumped = json.loads(stream_event_adapter.dump_json(parsed, by_alias=True))
    assert dumped["type"] == event_type
    assert dumped["payload"] == payload


@pytest.mark.parametrize("event_type", sorted(STAGE_TWO_EVENTS))
def test_every_stage_two_event_satisfies_the_published_schema(event_type: str) -> None:
    validator = Draft202012Validator(build_stream_event_schema())
    _, payload = STAGE_TWO_EVENTS[event_type]
    assert list(validator.iter_errors(envelope(event_type, payload))) == []


@pytest.mark.parametrize("event_type", sorted(STAGE_TWO_EVENTS))
def test_a_payload_missing_a_required_field_is_rejected(event_type: str) -> None:
    _, payload = STAGE_TWO_EVENTS[event_type]
    broken = dict(payload)
    broken.pop(next(iter(broken)))
    with pytest.raises(ValidationError):
        stream_event_adapter.validate_python(envelope(event_type, broken))
    validator = Draft202012Validator(build_stream_event_schema())
    assert list(validator.iter_errors(envelope(event_type, broken))) != []


def test_run_progress_keeps_pass_under_its_wire_name() -> None:
    parsed = stream_event_adapter.validate_python(envelope("run.progress", COUNTERS))
    assert isinstance(parsed, RunProgressEvent)
    assert parsed.payload.pass_ == 1


def test_a_budget_can_run_out_only_in_dollars_or_minutes() -> None:
    with pytest.raises(ValidationError):
        stream_event_adapter.validate_python(
            envelope("budget.exhausted", {"dimension": "tokens", "limit": 1, "actual": 2})
        )


def test_a_frame_event_needs_a_jpeg() -> None:
    _, payload = STAGE_TWO_EVENTS["tile.frame"]
    with pytest.raises(ValidationError):
        stream_event_adapter.validate_python(
            envelope("tile.frame", {**payload, "mime": "image/png"}, None)
        )


def test_the_event_union_still_knows_the_stage_zero_events() -> None:
    mapping = build_stream_event_schema()["discriminator"]["mapping"]
    assert {"stream.hello", "hello.tick", "run.created", "run.finished"} <= set(mapping)
    assert set(STAGE_TWO_EVENTS) <= set(mapping)
    assert set(mapping) == STREAM_EVENT_TYPES


@pytest.mark.parametrize(
    ("event_type", "feeds"),
    [
        ("run.progress", (FeedName.runs,)),
        ("budget.updated", (FeedName.runs,)),
        ("budget.exhausted", (FeedName.runs, FeedName.home)),
        ("scenario.queued", ()),
        ("scenario.started", ()),
        ("scenario.verdict", ()),
        ("scenario.finished", ()),
        ("step.recorded", ()),
        ("browser_session.started", ()),
        ("browser_session.ended", ()),
        ("tile.frame", ()),
    ],
)
def test_stage_two_events_reach_the_feeds_the_catalog_lists(
    event_type: str, feeds: tuple[FeedName, ...]
) -> None:
    assert event_type in EVENT_FEEDS
    assert feeds_for(event_type) == feeds


def test_every_stage_two_event_type_has_a_routing_entry() -> None:
    assert set(STAGE_TWO_EVENTS) <= set(EVENT_FEEDS)


def test_the_run_stream_still_accepts_the_two_client_messages() -> None:
    subscribe = stream_client_message_adapter.validate_python(
        {
            "type": "tile.subscribe",
            "payload": {"tiles": [{"browser_session_id": SESSION_ID, "mode": "focus"}]},
        }
    )
    ack = stream_client_message_adapter.validate_python(
        {"type": "tile.ack", "payload": {"browser_session_id": SESSION_ID, "frame_seq": 9}}
    )
    assert subscribe.type == "tile.subscribe"
    assert ack.type == "tile.ack"
    with pytest.raises(ValidationError):
        stream_client_message_adapter.validate_python(
            {"type": "tile.demand", "payload": {"browser_session_id": SESSION_ID}}
        )


def test_the_tile_ceilings_are_the_contract_numbers() -> None:
    assert (TILE_FPS_CEILING, TILE_QUALITY_FLOOR, TILE_QUALITY_CEILING) == (15, 30, 90)
    assert (TILE_WIDTH_CEILING, TILE_MAX_UNACKED_FRAMES) == (1920, 2)


def test_tile_demand_is_the_server_to_worker_message() -> None:
    message = TileDemandMessage.model_validate(
        {
            "type": "tile.demand",
            "payload": {
                "browser_session_id": SESSION_ID,
                "max_fps": 0,
                "quality": 30,
                "max_width": 640,
            },
        }
    )
    assert message.payload.max_fps == 0


@pytest.mark.parametrize(
    "overrides",
    [
        {"max_fps": 16},
        {"max_fps": -1},
        {"quality": 29},
        {"quality": 91},
        {"max_width": 1921},
        {"max_width": 0},
    ],
)
def test_tile_demand_stays_inside_the_clamps(overrides: dict[str, int]) -> None:
    payload = {"browser_session_id": SESSION_ID, "max_fps": 4, "quality": 60, "max_width": 640}
    with pytest.raises(ValidationError):
        TileDemandMessage.model_validate(
            {"type": "tile.demand", "payload": {**payload, **overrides}}
        )
