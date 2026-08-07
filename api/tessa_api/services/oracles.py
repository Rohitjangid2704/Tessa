import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import ColumnElement, and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, OracleResultRow, OracleTemplateRow
from tessa_api.errors import ApiError, not_found
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import (
    BundleValidationStatus,
    OracleApproval,
    OracleLanguage,
    OracleResultStatus,
)
from tessa_api.schemas.oracles import (
    OracleApprovalSet,
    OracleResult,
    OracleResultPage,
    OracleRunCreate,
    OracleTemplate,
    OracleTemplatePage,
)
from tessa_api.schemas.temporal import (
    RUN_ORACLE_WORKFLOW,
    RunOracleInput,
    run_oracle_workflow_id,
)
from tessa_api.services.oracle_params import validate_oracle_params
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.scenario_truth_checks import OracleView
from tessa_api.services.targets import get_target
from tessa_api.temporal_client import TemporalGateway

logger = logging.getLogger("tessa_api.oracles")

START_FAILED_MESSAGE = "The oracle workflow could not be started"
GOLD_KEY_FIELD = "key"

ORACLE_TEMPLATE_SORT_COLUMNS: dict[str, SortableColumn] = {
    "name": sortable(OracleTemplateRow.name, str),
    "approval": sortable(OracleTemplateRow.approval, str),
}
ORACLE_TEMPLATE_ID_COLUMN = sortable(OracleTemplateRow.id, uuid.UUID)
ORACLE_RESULT_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(OracleResultRow.created_at, datetime),
}
ORACLE_RESULT_ID_COLUMN = sortable(OracleResultRow.id, uuid.UUID)


@dataclass(frozen=True)
class OracleTemplateFilters:
    target_id: uuid.UUID | None = None
    bundle_id: uuid.UUID | None = None
    feature_ids: Sequence[str] = field(default_factory=tuple)
    approvals: Sequence[OracleApproval] = field(default_factory=tuple)


def to_oracle_template(row: OracleTemplateRow) -> OracleTemplate:
    return OracleTemplate(
        id=row.id,
        bundle_id=row.bundle_id,
        name=row.name,
        feature_ids=list(row.feature_ids),
        language=row.language,
        source=row.source,
        params_schema=row.params_schema,
        sentence_template=row.sentence_template,
        read_only_verified=row.read_only_verified,
        approval=row.approval,
    )


def to_oracle_result(row: OracleResultRow, max_rows: int) -> OracleResult:
    rows = list(row.rows)
    return OracleResult(
        id=row.id,
        oracle_template_id=row.oracle_template_id,
        params=row.params,
        status=row.status,
        rows=rows[:max_rows],
        rows_truncated=row.rows_truncated or len(rows) > max_rows,
        sentence=row.sentence,
        error=row.error,
        duration_ms=row.duration_ms,
        executed_at=row.executed_at,
    )


def to_oracle_view(row: OracleTemplateRow) -> OracleView:
    return OracleView(
        name=row.name,
        approval=row.approval,
        params_schema=row.params_schema,
        gold_keys=frozenset(
            str(point[GOLD_KEY_FIELD]) for point in row.gold_points if GOLD_KEY_FIELD in point
        ),
    )


async def oracle_views_for_bundle(session: AsyncSession, bundle_id: uuid.UUID) -> list[OracleView]:
    rows = await session.scalars(
        select(OracleTemplateRow).where(OracleTemplateRow.bundle_id == bundle_id)
    )
    return [to_oracle_view(row) for row in rows]


async def latest_valid_bundle_id(session: AsyncSession, target_id: uuid.UUID) -> uuid.UUID | None:
    return await session.scalar(
        select(BundleRow.id)
        .where(
            BundleRow.target_id == target_id,
            BundleRow.validation_status == BundleValidationStatus.valid,
        )
        .order_by(BundleRow.version.desc())
        .limit(1)
    )


async def template_conditions(
    session: AsyncSession, filters: OracleTemplateFilters
) -> list[ColumnElement[bool]] | None:
    conditions: list[ColumnElement[bool]] = []
    bundle_id = filters.bundle_id
    if filters.target_id is not None:
        await get_target(session, filters.target_id)
        conditions.append(OracleTemplateRow.target_id == filters.target_id)
        if bundle_id is None:
            bundle_id = await latest_valid_bundle_id(session, filters.target_id)
            if bundle_id is None:
                return None
    if bundle_id is not None:
        conditions.append(OracleTemplateRow.bundle_id == bundle_id)
    if filters.feature_ids:
        conditions.append(
            or_(*(OracleTemplateRow.feature_ids.contains([item]) for item in filters.feature_ids))
        )
    if filters.approvals:
        conditions.append(OracleTemplateRow.approval.in_(list(filters.approvals)))
    return conditions


async def list_oracle_templates(
    session: AsyncSession, query: PageQuery, filters: OracleTemplateFilters
) -> OracleTemplatePage:
    conditions = await template_conditions(session, filters)
    if conditions is None:
        return OracleTemplatePage(
            items=[], next_cursor=None, total=0 if query.include_total else None
        )
    statement = select(OracleTemplateRow)
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(
        session, statement, ORACLE_TEMPLATE_SORT_COLUMNS, ORACLE_TEMPLATE_ID_COLUMN, query
    )
    return OracleTemplatePage(
        items=[to_oracle_template(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def get_template_row(session: AsyncSession, template_id: uuid.UUID) -> OracleTemplateRow:
    row = await session.get(OracleTemplateRow, template_id)
    if row is None:
        raise not_found("Oracle template not found")
    return row


async def get_result_row(session: AsyncSession, result_id: uuid.UUID) -> OracleResultRow:
    row = await session.get(OracleResultRow, result_id)
    if row is None:
        raise not_found("Oracle result not found")
    return row


async def read_oracle_template(session: AsyncSession, template_id: uuid.UUID) -> OracleTemplate:
    return to_oracle_template(await get_template_row(session, template_id))


async def read_oracle_result(
    session: AsyncSession, result_id: uuid.UUID, max_rows: int
) -> OracleResult:
    return to_oracle_result(await get_result_row(session, result_id), max_rows)


async def list_oracle_results(
    session: AsyncSession, template_id: uuid.UUID, query: PageQuery, max_rows: int
) -> OracleResultPage:
    await get_template_row(session, template_id)
    statement = select(OracleResultRow).where(OracleResultRow.oracle_template_id == template_id)
    page = await paginate(
        session, statement, ORACLE_RESULT_SORT_COLUMNS, ORACLE_RESULT_ID_COLUMN, query
    )
    return OracleResultPage(
        items=[to_oracle_result(row[0], max_rows) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


def invalid_params_error(template: OracleTemplateRow, body: OracleRunCreate) -> ApiError | None:
    problems = validate_oracle_params(template.params_schema, body.params)
    if not problems:
        return None
    details = [
        ErrorDetail(
            loc=["body", "params", *problem.loc], code=problem.code, message=problem.message
        )
        for problem in problems
    ]
    return ApiError(422, "validation_failed", "Request validation failed", details)


async def mark_start_failed(session: AsyncSession, result_id: uuid.UUID) -> None:
    try:
        await session.execute(
            update(OracleResultRow)
            .where(
                OracleResultRow.id == result_id,
                OracleResultRow.status == OracleResultStatus.pending,
            )
            .values(
                status=OracleResultStatus.error,
                error=START_FAILED_MESSAGE,
                executed_at=datetime.now(UTC),
            )
        )
        await session.commit()
    except Exception:
        logger.exception("oracle_start_failure_not_recorded", extra={"result_id": str(result_id)})


async def start_oracle_run(
    session: AsyncSession,
    temporal: TemporalGateway,
    max_rows: int,
    template_id: uuid.UUID,
    body: OracleRunCreate,
) -> OracleResult:
    template = await get_template_row(session, template_id)
    invalid = invalid_params_error(template, body)
    if invalid is not None:
        raise invalid
    result = OracleResultRow(
        oracle_template_id=template.id,
        params=dict(body.params),
        status=OracleResultStatus.pending,
        rows=[],
        rows_truncated=False,
    )
    session.add(result)
    await session.commit()
    try:
        await temporal.start_workflow(
            RUN_ORACLE_WORKFLOW,
            RunOracleInput(oracle_result_id=result.id),
            run_oracle_workflow_id(result.id),
        )
    except Exception:
        await mark_start_failed(session, result.id)
        raise
    await session.refresh(result)
    return to_oracle_result(result, max_rows)


def approval_conflict(code: str, message: str) -> ApiError:
    detail = ErrorDetail(loc=["body", "approved"], code=code, message=message)
    return ApiError(409, "conflict", message, [detail])


def ensure_approvable(template: OracleTemplateRow, result: OracleResultRow) -> None:
    if result.status is not OracleResultStatus.ok:
        raise approval_conflict(
            "oracle_result_not_ok",
            "An oracle is approved after a result that finished without error",
        )
    if template.language is OracleLanguage.sql and not template.read_only_verified:
        raise approval_conflict(
            "oracle_not_read_only",
            "The oracle lint could not prove this query read-only, so it cannot be approved",
        )


async def set_oracle_approval(
    session: AsyncSession, template_id: uuid.UUID, body: OracleApprovalSet
) -> OracleTemplate:
    template = await get_template_row(session, template_id)
    result = await session.get(OracleResultRow, body.oracle_result_id)
    if result is None or result.oracle_template_id != template.id:
        detail = ErrorDetail(
            loc=["body", "oracle_result_id"],
            code="oracle_result_not_found",
            message="The result does not belong to this oracle",
        )
        raise ApiError(422, "validation_failed", "Request validation failed", [detail])
    if body.approved:
        ensure_approvable(template, result)
    template.approval = OracleApproval.approved if body.approved else OracleApproval.rejected
    await session.commit()
    return to_oracle_template(template)
