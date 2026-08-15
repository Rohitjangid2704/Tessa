from uuid import UUID

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.temporal import RenderReportResult
from tessa_api.services.reports import persist_report, render_report, report_refs
from tessa_api.services.storage import storage_from_settings
from tessa_worker.settings import WorkerSettings


class ReportBuilder:
    def __init__(self, settings: WorkerSettings, session_factory: SessionFactory) -> None:
        self.settings = settings
        self.session_factory = session_factory

    async def render(self, run_id: UUID) -> RenderReportResult:
        async with self.session_factory() as session:
            rendered = await render_report(session, self.settings.report_base_url, run_id)
        await persist_report(storage_from_settings(self.settings), run_id, rendered)
        refs = report_refs(run_id)
        return RenderReportResult(json_path=refs.json_ref, html_path=refs.html_ref)
