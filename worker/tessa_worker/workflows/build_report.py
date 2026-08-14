from datetime import timedelta

from pydantic import BaseModel
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.enums import ReportChannel
    from tessa_api.schemas.notification_plans import PlannedNotification
    from tessa_api.schemas.reports import (
        REPORT_HTML_FILE_NAME,
        REPORT_JSON_FILE_NAME,
        report_relative_path,
    )
    from tessa_api.schemas.temporal import (
        BUILD_REPORT_WORKFLOW,
        CREATE_NOTIFICATION_ACTIVITY,
        NOTIFY_SEND_MAX_ATTEMPTS,
        NOTIFY_SEND_START_TO_CLOSE,
        RENDER_REPORT_ACTIVITY,
        REPORT_START_TO_CLOSE,
        SEND_SLACK_ACTIVITY,
        BuildReportInput,
        BuildReportResult,
        ChannelSendResult,
        CreateNotificationResult,
        RenderReportInput,
        RenderReportResult,
    )
    from tessa_worker.activities.notify_models import (
        EVALUATE_NOTIFICATIONS,
        EvaluateNotificationsInput,
        EvaluateNotificationsResult,
    )
    from tessa_worker.workflows.calls import call_activity, failure_text

SEND_RETRY_POLICY = RetryPolicy(
    initial_interval=timedelta(seconds=2),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=30),
    maximum_attempts=NOTIFY_SEND_MAX_ATTEMPTS,
)


@workflow.defn(name=BUILD_REPORT_WORKFLOW)
class BuildReportWorkflow:
    def __init__(self) -> None:
        self.sent: list[ReportChannel] = []

    @workflow.run
    async def run(self, request: BuildReportInput) -> BuildReportResult:
        await self.render(request)
        await self.announce(request)
        return BuildReportResult(
            json_ref=report_relative_path(request.run_id, REPORT_JSON_FILE_NAME),
            html_ref=report_relative_path(request.run_id, REPORT_HTML_FILE_NAME),
            sent=self.sent,
        )

    async def render(self, request: BuildReportInput) -> None:
        try:
            await call_activity(
                RENDER_REPORT_ACTIVITY,
                RenderReportInput(run_id=request.run_id),
                RenderReportResult,
                REPORT_START_TO_CLOSE,
            )
        except ActivityError as error:
            workflow.logger.warning("report_not_rendered", extra={"cause": failure_text(error)})

    async def announce(self, request: BuildReportInput) -> None:
        for planned in await self.evaluate(request):
            await self.deliver(planned)

    async def evaluate(self, request: BuildReportInput) -> list[PlannedNotification]:
        try:
            result = await call_activity(
                EVALUATE_NOTIFICATIONS,
                EvaluateNotificationsInput(run_id=request.run_id, channels=request.channels),
                EvaluateNotificationsResult,
            )
        except ActivityError as error:
            workflow.logger.warning(
                "notifications_not_evaluated", extra={"cause": failure_text(error)}
            )
            return []
        return result.notifications

    async def deliver(self, planned: PlannedNotification) -> None:
        try:
            stored = await call_activity(
                CREATE_NOTIFICATION_ACTIVITY, planned.content, CreateNotificationResult
            )
        except ActivityError as error:
            workflow.logger.warning(
                "notification_not_stored",
                extra={"kind": planned.content.kind.value, "cause": failure_text(error)},
            )
            return
        if not stored.created:
            return
        if planned.slack is not None:
            await self.send(SEND_SLACK_ACTIVITY, planned.slack, ReportChannel.slack)

    async def send(self, activity_name: str, message: BaseModel, channel: ReportChannel) -> None:
        try:
            result: ChannelSendResult = await workflow.execute_activity(
                activity_name,
                message,
                result_type=ChannelSendResult,
                start_to_close_timeout=NOTIFY_SEND_START_TO_CLOSE,
                retry_policy=SEND_RETRY_POLICY,
            )
        except ActivityError as error:
            workflow.logger.warning(
                "channel_not_sent",
                extra={"channel": channel.value, "cause": failure_text(error)},
            )
            return
        if result.ok and channel not in self.sent:
            self.sent.append(channel)


__all__ = ["BuildReportWorkflow"]
