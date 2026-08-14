from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.enums import OracleResultStatus
    from tessa_api.schemas.temporal import (
        EXECUTE_ORACLE_QUERY_ACTIVITY,
        ORACLE_QUERY_MAX_ATTEMPTS,
        ORACLE_QUERY_START_TO_CLOSE,
        RENDER_EXPECTED_SENTENCE_ACTIVITY,
        RUN_ORACLE_WORKFLOW,
        ExecuteOracleQueryInput,
        ExecuteOracleQueryResult,
        RenderExpectedSentenceInput,
        RenderExpectedSentenceResult,
        RunOracleInput,
        RunOracleResult,
    )
    from tessa_worker.activities.oracle_models import (
        FAIL_ORACLE_RESULT,
        FailOracleResultInput,
    )
    from tessa_worker.workflows.calls import (
        call_activity,
        call_activity_without_result,
        failure_text,
    )

QUERY_RETRY_POLICY = RetryPolicy(maximum_attempts=ORACLE_QUERY_MAX_ATTEMPTS)


@workflow.defn(name=RUN_ORACLE_WORKFLOW)
class RunOracleWorkflow:
    @workflow.run
    async def run(self, request: RunOracleInput) -> RunOracleResult:
        try:
            return await self.execute_and_render(request)
        except ActivityError as error:
            await call_activity_without_result(
                FAIL_ORACLE_RESULT,
                FailOracleResultInput(
                    oracle_result_id=request.oracle_result_id, message=failure_text(error)
                ),
            )
            return RunOracleResult(status=OracleResultStatus.error)

    async def execute_and_render(self, request: RunOracleInput) -> RunOracleResult:
        executed: ExecuteOracleQueryResult = await workflow.execute_activity(
            EXECUTE_ORACLE_QUERY_ACTIVITY,
            ExecuteOracleQueryInput(oracle_result_id=request.oracle_result_id),
            result_type=ExecuteOracleQueryResult,
            start_to_close_timeout=ORACLE_QUERY_START_TO_CLOSE,
            retry_policy=QUERY_RETRY_POLICY,
        )
        if executed.status is not OracleResultStatus.ok:
            return RunOracleResult(status=executed.status)
        rendered = await call_activity(
            RENDER_EXPECTED_SENTENCE_ACTIVITY,
            RenderExpectedSentenceInput(oracle_result_id=request.oracle_result_id),
            RenderExpectedSentenceResult,
        )
        status = OracleResultStatus.ok if rendered.error is None else OracleResultStatus.error
        return RunOracleResult(status=status)
