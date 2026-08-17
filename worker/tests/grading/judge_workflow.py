from datetime import timedelta

from pydantic import BaseModel
from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.grading import JudgeStepInput, JudgeStepOutput
    from tessa_api.schemas.temporal import JUDGE_MAX_ATTEMPTS, JUDGE_START_TO_CLOSE

JUDGE_PROBE_WORKFLOW = "JudgeProbeWorkflow"
RETRY_INTERVAL = timedelta(milliseconds=10)


class JudgeProbeCall(BaseModel):
    activity_name: str
    request: JudgeStepInput


@workflow.defn(name=JUDGE_PROBE_WORKFLOW)
class JudgeProbeWorkflow:
    @workflow.run
    async def run(self, call: JudgeProbeCall) -> JudgeStepOutput:
        output: JudgeStepOutput = await workflow.execute_activity(
            call.activity_name,
            call.request,
            result_type=JudgeStepOutput,
            start_to_close_timeout=JUDGE_START_TO_CLOSE,
            retry_policy=RetryPolicy(
                maximum_attempts=JUDGE_MAX_ATTEMPTS, initial_interval=RETRY_INTERVAL
            ),
        )
        return output
