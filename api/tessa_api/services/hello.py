from datetime import datetime
from typing import Any
from uuid import UUID

from tessa_api.schemas.common import RunCounters
from tessa_api.schemas.enums import RunKind, RunStatus, RunTrigger
from tessa_api.schemas.streams import IngestEvent, RunCreatedPayload, RunFinishedPayload

HELLO_WORKFLOW_NAME = "HelloWorkflow"
RUN_CREATED_DEDUPE_KEY = "created"
RUN_FINISHED_DEDUPE_KEY = "finished"
LAYA_SMOKE_TEXT = "Hello from Tessa: this is a smoke check, please answer."


def hello_workflow_id(run_id: UUID) -> str:
    return f"hello-{run_id}"


def zero_run_counters() -> RunCounters:
    return RunCounters.model_validate(
        {
            "scenarios_total": 0,
            "scenarios_done": 0,
            "pass": 0,
            "fail": 0,
            "flaky": 0,
            "uncertain": 0,
            "skipped": 0,
            "steps_recorded": 0,
        }
    )


def run_finished_payload(status: RunStatus, duration_ms: int) -> dict[str, Any]:
    payload = RunFinishedPayload(
        status=status,
        counters=zero_run_counters(),
        spent_usd=0.0,
        duration_ms=duration_ms,
    )
    return payload.model_dump(mode="json", by_alias=True)


def run_created_event(run_id: UUID, created_by: UUID, occurred_at: datetime) -> IngestEvent:
    payload = RunCreatedPayload(
        kind=RunKind.hello,
        target_id=None,
        plan_id=None,
        trigger=RunTrigger.api,
        created_by=created_by,
        status=RunStatus.queued,
    )
    return IngestEvent(
        run_id=run_id,
        type="run.created",
        payload=payload.model_dump(mode="json"),
        dedupe_key=RUN_CREATED_DEDUPE_KEY,
        occurred_at=occurred_at,
    )


def run_failed_event(run_id: UUID, occurred_at: datetime, duration_ms: int) -> IngestEvent:
    return IngestEvent(
        run_id=run_id,
        type="run.finished",
        payload=run_finished_payload(RunStatus.failed, duration_ms),
        dedupe_key=RUN_FINISHED_DEDUPE_KEY,
        occurred_at=occurred_at,
    )
