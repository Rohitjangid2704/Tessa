import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import ExplanationRow
from tessa_api.errors import ApiError
from tessa_api.ids import new_id
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import ExplanationSource
from tessa_api.schemas.explanations import (
    Explanation,
    ExplanationCreate,
    ExplanationPage,
    ExplanationStructured,
)
from tessa_api.services.findings.queries import get_finding_row, to_explanation
from tessa_api.services.grading_rules import redacted_text
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable

EXPLANATION_SORT_COLUMNS: Mapping[str, SortableColumn] = {
    "created_at": sortable(ExplanationRow.created_at, datetime)
}
EXPLANATION_ID_COLUMN = sortable(ExplanationRow.id, uuid.UUID)


def explanation_too_long(limit: int, length: int) -> ApiError:
    detail = ErrorDetail(
        loc=["body", "text"],
        code="string_too_long",
        message=f"String should have at most {limit} characters, got {length}",
    )
    return ApiError(422, "validation_failed", "Request validation failed", [detail])


def ensure_within_limit(text: str, limit: int) -> None:
    if len(text) > limit:
        raise explanation_too_long(limit, len(text))


def redacted_structured(structured: ExplanationStructured | None) -> dict[str, Any] | None:
    if structured is None:
        return None
    safe = structured.model_copy(update={"root_cause": redacted_text(structured.root_cause)})
    return safe.model_dump(mode="json")


async def create_explanation(
    session: AsyncSession,
    user_id: uuid.UUID,
    finding_id: uuid.UUID,
    body: ExplanationCreate,
    max_chars: int,
) -> Explanation:
    ensure_within_limit(body.text, max_chars)
    await get_finding_row(session, finding_id)
    row = ExplanationRow(
        id=new_id(),
        finding_id=finding_id,
        text=redacted_text(body.text),
        source=ExplanationSource.claude_code,
        created_by=user_id,
        structured=redacted_structured(body.structured),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return to_explanation(row)


async def list_explanations(
    session: AsyncSession, finding_id: uuid.UUID, query: PageQuery
) -> ExplanationPage:
    await get_finding_row(session, finding_id)
    statement = select(ExplanationRow).where(ExplanationRow.finding_id == finding_id)
    page = await paginate(
        session, statement, EXPLANATION_SORT_COLUMNS, EXPLANATION_ID_COLUMN, query
    )
    return ExplanationPage(
        items=[to_explanation(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )
