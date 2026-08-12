from datetime import timedelta
from typing import Any
from uuid import UUID

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.hello import EmitRunEventInput, EmitRunEventResult
    from tessa_worker.activities.names import EMIT_RUN_EVENT

EMIT_START_TO_CLOSE = timedelta(seconds=10)
EMIT_RETRY_POLICY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=10),
    maximum_attempts=5,
)


async def emit_event(
    run_id: UUID, event_type: str, payload: dict[str, Any], dedupe_key: str
) -> int | None:
    try:
        result: EmitRunEventResult = await workflow.execute_activity(
            EMIT_RUN_EVENT,
            EmitRunEventInput(
                run_id=run_id,
                type=event_type,
                payload=payload,
                dedupe_key=dedupe_key,
                ephemeral=False,
            ),
            result_type=EmitRunEventResult,
            start_to_close_timeout=EMIT_START_TO_CLOSE,
            retry_policy=EMIT_RETRY_POLICY,
        )
    except ActivityError as error:
        workflow.logger.warning(
            "run_event_not_delivered",
            extra={
                "run_id": str(run_id),
                "event_type": event_type,
                "dedupe_key": dedupe_key,
                "cause": type(error.cause).__name__,
            },
        )
        return None
    return result.seq
