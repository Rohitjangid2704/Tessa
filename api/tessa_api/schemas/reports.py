from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.findings import FindingSummary
from tessa_api.schemas.run_stats import RunDiff, RunStats
from tessa_api.schemas.runs import Run, RunConfigSnapshot

REPORT_SCHEMA_VERSION = 1
REPORT_DIRECTORY_NAME = "reports"
REPORT_JSON_FILE_NAME = "report.json"
REPORT_HTML_FILE_NAME = "report.html"
REPORT_HTML_CONTENT_SECURITY_POLICY = "sandbox"
REPORT_HTML_CONTENT_TYPE_OPTIONS = "nosniff"


def report_html_content_disposition(run_id: UUID) -> str:
    return f'inline; filename="run-{run_id}.html"'


def report_relative_path(run_id: UUID, file_name: str) -> str:
    return f"{REPORT_DIRECTORY_NAME}/{run_id}/{file_name}"


class RunReport(BaseModel):
    run: Run
    stats: RunStats
    findings: list[FindingSummary] = Field(
        description="findings that have an occurrence in this run"
    )
    diff: RunDiff | None = Field(
        description="verdict changes against the previous completed run of the plan; null when "
        "there is none"
    )
    config_snapshot: RunConfigSnapshot
    generated_at: Timestamp
