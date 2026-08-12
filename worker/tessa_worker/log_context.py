from collections.abc import Sequence
from typing import Any

from temporalio import activity, workflow
from temporalio.worker import (
    ActivityInboundInterceptor,
    ExecuteActivityInput,
    ExecuteWorkflowInput,
    Interceptor,
    WorkflowInboundInterceptor,
    WorkflowInterceptorClassInput,
)

with workflow.unsafe.imports_passed_through():
    from tessa_api.logging_config import bound_log_context


def run_id_of(arguments: Sequence[object]) -> str | None:
    for argument in arguments:
        value = getattr(argument, "run_id", None)
        if value is not None:
            return str(value)
    return None


class LogContextActivityInterceptor(ActivityInboundInterceptor):
    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        info = activity.info()
        with bound_log_context(run_id_of(input.args), info.workflow_id, info.activity_type):
            return await self.next.execute_activity(input)


class LogContextWorkflowInterceptor(WorkflowInboundInterceptor):
    async def execute_workflow(self, input: ExecuteWorkflowInput) -> Any:
        with bound_log_context(run_id_of(input.args), workflow.info().workflow_id, None):
            return await self.next.execute_workflow(input)


class LogContextInterceptor(Interceptor):
    def intercept_activity(self, next: ActivityInboundInterceptor) -> ActivityInboundInterceptor:
        return LogContextActivityInterceptor(next)

    def workflow_interceptor_class(
        self, input: WorkflowInterceptorClassInput
    ) -> type[WorkflowInboundInterceptor]:
        return LogContextWorkflowInterceptor
