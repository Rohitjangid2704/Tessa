import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment

from tessa_api.schemas.hello import HelloWorkflowState, LayaSmokeResult
from tessa_worker.workflows.hello import HelloWorkflow
from tests.hello_support import (
    StubEmitter,
    StubLaya,
    hello_input,
    run_hello,
    running_worker,
    start_hello,
    wait_until,
)

pytestmark = pytest.mark.integration


async def test_five_ticks_with_laya_emit_the_documented_events_in_order(
    temporal_env: WorkflowEnvironment,
) -> None:
    emitter, laya = StubEmitter(), StubLaya()
    async with running_worker(temporal_env, [emitter.emit_run_event, laya.laya_smoke_call]):
        result = await run_hello(temporal_env, hello_input())
    assert emitter.types == [
        "run.status_changed",
        "hello.tick",
        "hello.tick",
        "hello.tick",
        "hello.tick",
        "hello.tick",
        "hello.laya",
        "run.finished",
    ]
    assert emitter.dedupe_keys == [
        "status:running",
        "tick:1",
        "tick:2",
        "tick:3",
        "tick:4",
        "tick:5",
        "laya",
        "finished",
    ]
    assert result.ticks_emitted == 5
    assert result.laya == LayaSmokeResult(
        ok=True, latency_ms=12, status_code=200, response_excerpt="noul=0.9"
    )
    assert len(laya.calls) == 1


async def test_payloads_follow_the_stream_event_contract(
    temporal_env: WorkflowEnvironment,
) -> None:
    emitter, laya = StubEmitter(), StubLaya()
    async with running_worker(temporal_env, [emitter.emit_run_event, laya.laya_smoke_call]):
        await run_hello(temporal_env, hello_input(ticks=2))
    assert emitter.payloads("run.status_changed") == [
        {"status": "running", "previous": "queued", "reason": None}
    ]
    assert emitter.payloads("hello.tick") == [
        {"n": 1, "total": 2, "message": "tick 1 of 2"},
        {"n": 2, "total": 2, "message": "tick 2 of 2"},
    ]
    assert emitter.payloads("hello.laya") == [
        {"ok": True, "latency_ms": 12, "status_code": 200, "error": None}
    ]
    finished = emitter.payloads("run.finished")[0]
    assert finished["status"] == "completed"
    assert finished["spent_usd"] == 0.0
    assert finished["duration_ms"] >= 1000
    assert finished["counters"] == {
        "scenarios_total": 0,
        "scenarios_done": 0,
        "pass": 0,
        "fail": 0,
        "flaky": 0,
        "uncertain": 0,
        "skipped": 0,
        "steps_recorded": 0,
    }


async def test_without_laya_there_is_no_laya_call_or_event(
    temporal_env: WorkflowEnvironment,
) -> None:
    emitter, laya = StubEmitter(), StubLaya()
    async with running_worker(temporal_env, [emitter.emit_run_event, laya.laya_smoke_call]):
        result = await run_hello(temporal_env, hello_input(ticks=3, include_laya=False))
    assert "hello.laya" not in emitter.types
    assert emitter.types[-1] == "run.finished"
    assert result.laya is None
    assert laya.calls == []


async def test_a_laya_failure_result_becomes_ok_false_and_the_run_still_completes(
    temporal_env: WorkflowEnvironment,
) -> None:
    emitter = StubEmitter()
    laya = StubLaya(
        result=LayaSmokeResult(
            ok=False, latency_ms=31, status_code=500, response_excerpt="HTTP 500: inference failed"
        )
    )
    async with running_worker(temporal_env, [emitter.emit_run_event, laya.laya_smoke_call]):
        result = await run_hello(temporal_env, hello_input(ticks=1))
    assert emitter.payloads("hello.laya") == [
        {"ok": False, "latency_ms": 31, "status_code": 500, "error": "HTTP 500: inference failed"}
    ]
    assert emitter.payloads("run.finished")[0]["status"] == "completed"
    assert result.laya is not None
    assert result.laya.ok is False


async def test_a_crashing_laya_activity_becomes_ok_false_and_the_run_still_completes(
    temporal_env: WorkflowEnvironment,
) -> None:
    emitter = StubEmitter()
    laya = StubLaya(failure=ApplicationError("laya exploded", non_retryable=True))
    async with running_worker(temporal_env, [emitter.emit_run_event, laya.laya_smoke_call]):
        result = await run_hello(temporal_env, hello_input(ticks=1))
    laya_payload = emitter.payloads("hello.laya")[0]
    assert laya_payload["ok"] is False
    assert laya_payload["error"] == "activity failed: ApplicationError"
    assert emitter.payloads("run.finished")[0]["status"] == "completed"
    assert result.laya is not None
    assert result.laya.ok is False
    assert len(laya.calls) == 1


async def test_laya_is_called_once_even_when_it_keeps_failing(
    temporal_env: WorkflowEnvironment,
) -> None:
    emitter = StubEmitter()
    laya = StubLaya(failure=RuntimeError("connection refused"))
    async with running_worker(temporal_env, [emitter.emit_run_event, laya.laya_smoke_call]):
        await run_hello(temporal_env, hello_input(ticks=1))
    assert len(laya.calls) == 1


async def test_event_delivery_is_retried_five_times_then_given_up_without_failing_the_run(
    temporal_env: WorkflowEnvironment,
) -> None:
    emitter = StubEmitter(failing_types=frozenset({"hello.tick"}))
    laya = StubLaya()
    async with running_worker(temporal_env, [emitter.emit_run_event, laya.laya_smoke_call]):
        result = await run_hello(temporal_env, hello_input(ticks=2))
    assert "hello.tick" not in emitter.types
    assert emitter.types == ["run.status_changed", "hello.laya", "run.finished"]
    assert emitter.attempts == 3 + 2 * 5
    assert result.ticks_emitted == 2


async def test_stop_ends_the_tick_loop_skips_laya_and_finishes_completed(
    temporal_env: WorkflowEnvironment,
) -> None:
    emitter, laya = StubEmitter(), StubLaya()
    request = hello_input(ticks=60, tick_interval_ms=100)
    async with running_worker(temporal_env, [emitter.emit_run_event, laya.laya_smoke_call]):
        handle = await start_hello(temporal_env, request)

        async def two_ticks_emitted() -> bool:
            state = await handle.query(HelloWorkflow.state)
            return state.ticks_emitted >= 2

        await wait_until(two_ticks_emitted)
        await handle.signal(HelloWorkflow.stop)
        result = await handle.result()
    assert 2 <= result.ticks_emitted < 60
    assert result.laya is None
    assert laya.calls == []
    assert emitter.payloads("run.finished")[0]["status"] == "completed"
    assert emitter.types.count("hello.tick") == result.ticks_emitted


async def test_state_query_reports_progress_and_the_finished_stage(
    temporal_env: WorkflowEnvironment,
) -> None:
    emitter, laya = StubEmitter(), StubLaya()
    request = hello_input(ticks=3, tick_interval_ms=100)
    async with running_worker(temporal_env, [emitter.emit_run_event, laya.laya_smoke_call]):
        handle = await start_hello(temporal_env, request)
        await handle.result()
        state = await handle.query(HelloWorkflow.state)
    assert state == HelloWorkflowState(
        stage="finished", ticks_emitted=3, ticks_total=3, stop_requested=False
    )
