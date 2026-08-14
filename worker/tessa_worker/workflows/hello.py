from datetime import timedelta
from typing import Literal

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.enums import RunStatus
    from tessa_api.schemas.hello import (
        HelloWorkflowInput,
        HelloWorkflowResult,
        HelloWorkflowState,
        LayaSmokeInput,
        LayaSmokeResult,
    )
    from tessa_api.schemas.streams import (
        HelloLayaPayload,
        HelloTickPayload,
        RunStatusChangedPayload,
    )
    from tessa_api.services.hello import (
        HELLO_WORKFLOW_NAME,
        LAYA_SMOKE_TEXT,
        RUN_FINISHED_DEDUPE_KEY,
        run_finished_payload,
    )
    from tessa_worker.activities.names import LAYA_SMOKE_CALL
    from tessa_worker.events import emit_event

LAYA_START_TO_CLOSE = timedelta(seconds=60)

Stage = Literal["starting", "ticking", "calling_laya", "finishing", "finished"]


@workflow.defn(name=HELLO_WORKFLOW_NAME)
class HelloWorkflow:
    def __init__(self) -> None:
        self.stage: Stage = "starting"
        self.ticks_emitted = 0
        self.ticks_total = 0
        self.stop_requested = False

    @workflow.run
    async def run(self, request: HelloWorkflowInput) -> HelloWorkflowResult:
        started_at = workflow.now()
        self.ticks_total = request.ticks
        await emit_event(
            request.run_id,
            "run.status_changed",
            RunStatusChangedPayload(
                status=RunStatus.running, previous=RunStatus.queued, reason=None
            ).model_dump(mode="json"),
            "status:running",
        )
        self.stage = "ticking"
        await self.emit_ticks(request)
        laya = await self.call_laya(request)
        self.stage = "finishing"
        duration_ms = round((workflow.now() - started_at).total_seconds() * 1000)
        await emit_event(
            request.run_id,
            "run.finished",
            run_finished_payload(RunStatus.completed, duration_ms),
            RUN_FINISHED_DEDUPE_KEY,
        )
        self.stage = "finished"
        return HelloWorkflowResult(ticks_emitted=self.ticks_emitted, laya=laya)

    @workflow.signal
    def stop(self) -> None:
        self.stop_requested = True

    @workflow.query
    def state(self) -> HelloWorkflowState:
        return HelloWorkflowState(
            stage=self.stage,
            ticks_emitted=self.ticks_emitted,
            ticks_total=self.ticks_total,
            stop_requested=self.stop_requested,
        )

    async def emit_ticks(self, request: HelloWorkflowInput) -> None:
        for number in range(1, request.ticks + 1):
            if self.stop_requested:
                return
            await emit_event(
                request.run_id,
                "hello.tick",
                HelloTickPayload(
                    n=number, total=request.ticks, message=f"tick {number} of {request.ticks}"
                ).model_dump(mode="json"),
                f"tick:{number}",
            )
            self.ticks_emitted = number
            if number < request.ticks:
                await self.pause(timedelta(milliseconds=request.tick_interval_ms))

    async def pause(self, interval: timedelta) -> None:
        try:
            await workflow.wait_condition(lambda: self.stop_requested, timeout=interval)
        except TimeoutError:
            return

    async def call_laya(self, request: HelloWorkflowInput) -> LayaSmokeResult | None:
        if not request.include_laya or self.stop_requested:
            return None
        self.stage = "calling_laya"
        try:
            result: LayaSmokeResult = await workflow.execute_activity(
                LAYA_SMOKE_CALL,
                LayaSmokeInput(text=LAYA_SMOKE_TEXT),
                result_type=LayaSmokeResult,
                start_to_close_timeout=LAYA_START_TO_CLOSE,
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
        except ActivityError as error:
            result = LayaSmokeResult(
                ok=False,
                latency_ms=0,
                status_code=None,
                response_excerpt=f"activity failed: {type(error.cause).__name__}",
            )
        await emit_event(
            request.run_id,
            "hello.laya",
            HelloLayaPayload(
                ok=result.ok,
                latency_ms=result.latency_ms,
                status_code=result.status_code,
                error=None if result.ok else result.response_excerpt,
            ).model_dump(mode="json"),
            "laya",
        )
        return result
