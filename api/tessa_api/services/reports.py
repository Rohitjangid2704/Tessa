import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import FindingRow, RunRow
from tessa_api.errors import ApiError
from tessa_api.schemas.findings import FindingSummary
from tessa_api.schemas.reports import (
    REPORT_HTML_CONTENT_SECURITY_POLICY,
    REPORT_HTML_CONTENT_TYPE_OPTIONS,
    REPORT_HTML_FILE_NAME,
    REPORT_JSON_FILE_NAME,
    RunReport,
    report_html_content_disposition,
    report_relative_path,
)
from tessa_api.schemas.run_stats import RunDiff
from tessa_api.services.findings.queries import (
    SEVERITY_RANK_EXPRESSION,
    FindingFilters,
    finding_conditions,
    to_summary,
)
from tessa_api.services.report_html import render_report_html
from tessa_api.services.run_diff import build_run_diff, previous_completed_run
from tessa_api.services.run_stats import read_run_stats
from tessa_api.services.run_views import TERMINAL_RUN_STATUSES, get_run_row, to_run_with_link
from tessa_api.services.storage import Storage, StorageError, StorageKey, storage_key

logger = logging.getLogger("tessa_api.reports")

REPORT_FINDINGS_MAX = 500
REPORT_JSON_CONTENT_TYPE = "application/json"
REPORT_HTML_CONTENT_TYPE = "text/html; charset=utf-8"


@dataclass(frozen=True, slots=True)
class ReportKeys:
    json_key: StorageKey
    html_key: StorageKey


@dataclass(frozen=True, slots=True)
class RenderedReport:
    report: RunReport
    html: str


@dataclass(frozen=True, slots=True)
class ReportRefs:
    json_ref: str
    html_ref: str


def report_not_ready() -> ApiError:
    return ApiError(409, "report_not_ready", "The report is available once the run has finished")


def report_refs(run_id: UUID) -> ReportRefs:
    return ReportRefs(
        json_ref=report_relative_path(run_id, REPORT_JSON_FILE_NAME),
        html_ref=report_relative_path(run_id, REPORT_HTML_FILE_NAME),
    )


def report_html_headers(run_id: UUID) -> dict[str, str]:
    return {
        "Content-Security-Policy": REPORT_HTML_CONTENT_SECURITY_POLICY,
        "X-Content-Type-Options": REPORT_HTML_CONTENT_TYPE_OPTIONS,
        "Content-Disposition": report_html_content_disposition(run_id),
    }


def report_keys(run_id: UUID) -> ReportKeys:
    refs = report_refs(run_id)
    return ReportKeys(json_key=storage_key(refs.json_ref), html_key=storage_key(refs.html_ref))


async def list_run_findings(session: AsyncSession, run_id: UUID) -> list[FindingSummary]:
    conditions = finding_conditions(FindingFilters(run_id=run_id))
    rows = await session.scalars(
        select(FindingRow)
        .where(and_(*conditions))
        .order_by(SEVERITY_RANK_EXPRESSION.desc(), FindingRow.last_seen_at.desc(), FindingRow.id)
        .limit(REPORT_FINDINGS_MAX)
    )
    return [to_summary(row) for row in rows]


async def report_diff(session: AsyncSession, row: RunRow) -> RunDiff | None:
    previous = await previous_completed_run(session, row)
    if previous is None:
        return None
    return await build_run_diff(session, row.id, previous.id)


async def build_report_of(session: AsyncSession, row: RunRow) -> RunReport:
    if row.status not in TERMINAL_RUN_STATUSES:
        raise report_not_ready()
    generated_at = datetime.now(UTC)
    run = to_run_with_link(row, generated_at, None)
    return RunReport(
        run=run,
        stats=await read_run_stats(session, row.id),
        findings=await list_run_findings(session, row.id),
        diff=await report_diff(session, row),
        config_snapshot=run.config_snapshot,
        generated_at=generated_at,
    )


async def build_run_report(session: AsyncSession, run_id: UUID) -> RunReport:
    return await build_report_of(session, await get_run_row(session, run_id))


async def render_report(session: AsyncSession, base_url: str, run_id: UUID) -> RenderedReport:
    report = await build_run_report(session, run_id)
    html = await asyncio.to_thread(render_report_html, report, base_url)
    return RenderedReport(report=report, html=html)


async def persist_report(storage: Storage, run_id: UUID, rendered: RenderedReport) -> ReportKeys:
    keys = report_keys(run_id)
    document = rendered.report.model_dump_json(by_alias=True).encode("utf-8")
    await storage.put(keys.json_key, document, REPORT_JSON_CONTENT_TYPE)
    await storage.put(keys.html_key, rendered.html.encode("utf-8"), REPORT_HTML_CONTENT_TYPE)
    return keys


def parse_stored_report(run_id: UUID, document: bytes) -> RunReport | None:
    try:
        return RunReport.model_validate_json(document)
    except ValidationError:
        logger.warning("stored_report_unreadable", extra={"run_id": str(run_id)})
        return None


def decode_stored_html(run_id: UUID, document: bytes) -> str | None:
    try:
        return document.decode("utf-8")
    except UnicodeDecodeError:
        logger.warning("stored_report_unreadable", extra={"run_id": str(run_id)})
        return None


async def read_stored_report(storage: Storage, run_id: UUID) -> RenderedReport | None:
    keys = report_keys(run_id)
    json_document = await storage.get(keys.json_key)
    html_document = await storage.get(keys.html_key)
    if json_document is None or html_document is None:
        return None
    report = parse_stored_report(run_id, json_document)
    html = decode_stored_html(run_id, html_document)
    if report is None or html is None:
        return None
    return RenderedReport(report=report, html=html)


async def load_report(
    session: AsyncSession, storage: Storage, base_url: str, run_id: UUID
) -> RenderedReport:
    await get_run_row(session, run_id)
    try:
        stored = await read_stored_report(storage, run_id)
    except StorageError:
        logger.warning("report_not_read", extra={"run_id": str(run_id)})
        stored = None
    if stored is not None:
        return stored
    rendered = await render_report(session, base_url, run_id)
    try:
        await persist_report(storage, run_id, rendered)
    except (OSError, StorageError):
        logger.warning("report_not_stored", extra={"run_id": str(run_id)})
    return rendered
