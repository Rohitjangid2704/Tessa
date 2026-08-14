from temporalio import activity

from tessa_api.schemas.temporal import (
    RENDER_REPORT_ACTIVITY,
    RenderReportInput,
    RenderReportResult,
)
from tessa_worker.activities.scenarios import api_errors_as_application_errors
from tessa_worker.reports.builder import ReportBuilder


class ReportActivities:
    def __init__(self, builder: ReportBuilder) -> None:
        self.builder = builder

    @activity.defn(name=RENDER_REPORT_ACTIVITY)
    async def render_report(self, request: RenderReportInput) -> RenderReportResult:
        with api_errors_as_application_errors():
            return await self.builder.render(request.run_id)
