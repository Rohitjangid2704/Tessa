from datetime import timedelta

from pydantic import BaseModel
from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.temporal import (
        PLAIN_ACTIVITY_MAX_ATTEMPTS,
        PLAIN_ACTIVITY_START_TO_CLOSE,
    )

PLAIN_RETRY_POLICY = RetryPolicy(maximum_attempts=PLAIN_ACTIVITY_MAX_ATTEMPTS)
FAILURE_TEXT_LIMIT = 200


async def call_activity[ResultT](
    name: str,
    argument: BaseModel,
    result_type: type[ResultT],
    start_to_close: timedelta = PLAIN_ACTIVITY_START_TO_CLOSE,
) -> ResultT:
    result: ResultT = await workflow.execute_activity(
        name,
        argument,
        result_type=result_type,
        start_to_close_timeout=start_to_close,
        retry_policy=PLAIN_RETRY_POLICY,
    )
    return result


async def call_activity_without_argument[ResultT](name: str, result_type: type[ResultT]) -> ResultT:
    result: ResultT = await workflow.execute_activity(
        name,
        result_type=result_type,
        start_to_close_timeout=PLAIN_ACTIVITY_START_TO_CLOSE,
        retry_policy=PLAIN_RETRY_POLICY,
    )
    return result


async def call_activity_without_result(name: str, argument: BaseModel) -> None:
    await workflow.execute_activity(
        name,
        argument,
        start_to_close_timeout=PLAIN_ACTIVITY_START_TO_CLOSE,
        retry_policy=PLAIN_RETRY_POLICY,
    )


def failure_text(error: BaseException) -> str:
    root = error
    while root.__cause__ is not None:
        root = root.__cause__
    return f"{type(root).__name__}: {root}"[:FAILURE_TEXT_LIMIT]
