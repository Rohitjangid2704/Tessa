import logging
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    ColumnElement,
    Float,
    Select,
    Text,
    and_,
    case,
    cast,
    delete,
    exists,
    func,
    literal,
    literal_column,
    not_,
    null,
    select,
    type_coerce,
)
from sqlalchemy.dialects.postgresql import BIT, insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from tessa_api.db.models import JudgeResultRow, LabelRow, ProbeResultRow, RunRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.errors import ApiError, forbidden, not_found
from tessa_api.ids import new_id
from tessa_api.schemas.enums import (
    LabelReason,
    LabelSource,
    LabelSubjectType,
    LabelValue,
    VerdictStatus,
)
from tessa_api.schemas.labels import (
    Label,
    LabelCreate,
    LabelPage,
    LabelStats,
    LabelTask,
    LabelTaskPage,
)
from tessa_api.schemas.streams import IngestEvent
from tessa_api.services.calibration_cache import CALIBRATION_CACHE
from tessa_api.services.dashboard_events import dashboard_invalidate_event
from tessa_api.services.grading_rules import (
    AUDIT_HASH_HEX_DIGITS,
    AUDIT_HASH_SPACE,
    LABEL_VALUE_OF_STATUS,
    clip_text,
    label_value_of,
    redacted_text,
)
from tessa_api.services.pagination import (
    PageQuery,
    SortableColumn,
    paginate,
    sortable,
)
from tessa_api.services.settings_service import resolve_thresholds
from tessa_api.services.step_overlay import lock_step, refresh_step_verdict
from tessa_api.settings import Settings
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import append_events

logger = logging.getLogger("tessa_api.labels")

DECIDED_STATUSES = (VerdictStatus.pass_.value, VerdictStatus.fail.value)
LABELABLE_STATUSES = tuple(status.value for status in LABEL_VALUE_OF_STATUS)
QUESTION_LABEL_CHARS = 160
EXCERPT_CHARS = 280

SUBJECT_ID_COLUMNS: Mapping[LabelSubjectType, InstrumentedAttribute[uuid.UUID]] = {
    LabelSubjectType.probe_result: ProbeResultRow.id,
    LabelSubjectType.judge_result: JudgeResultRow.id,
    LabelSubjectType.step: StepRow.id,
}
LABEL_SORT_COLUMNS: Mapping[str, SortableColumn] = {
    "labeled_at": sortable(LabelRow.labeled_at, datetime)
}
LABEL_ID_COLUMN = sortable(LabelRow.id, uuid.UUID)
QUEUE_SORT_COLUMNS: Mapping[str, SortableColumn] = {
    "created_at": sortable(StepRow.finished_at, datetime)
}
QUEUE_ID_COLUMN = sortable(StepRow.id, uuid.UUID)
CONFLICT_COLUMNS = (
    LabelRow.subject_type,
    LabelRow.subject_id,
    LabelRow.source,
    LabelRow.labeled_by,
)
FRESHLY_INSERTED = literal_column("(xmax = 0)", Boolean).label("inserted")


@dataclass(frozen=True, slots=True)
class SavedLabel:
    label: Label
    created: bool
    events: list[IngestEvent]


@dataclass(frozen=True, slots=True)
class LabelFilters:
    subject_types: Sequence[LabelSubjectType] = ()
    subject_id: uuid.UUID | None = None
    sources: Sequence[LabelSource] = ()
    labeled_by: uuid.UUID | None = None


@dataclass(frozen=True, slots=True)
class QueueFilters:
    subject_types: Sequence[LabelSubjectType] = ()
    reasons: Sequence[LabelReason] = ()
    target_id: uuid.UUID | None = None


async def publish_label_events(
    session_factory: SessionFactory, hub: Hub, events: Sequence[IngestEvent]
) -> None:
    if not events:
        return
    try:
        await append_events(session_factory, hub, events)
    except Exception:
        logger.exception(
            "label_events_not_appended", extra={"events": [event.type for event in events]}
        )


def announce_label_change(events: Sequence[IngestEvent]) -> list[IngestEvent]:
    CALIBRATION_CACHE.invalidate()
    return [*events, dashboard_invalidate_event()]


def to_label(row: LabelRow) -> Label:
    return Label(
        id=row.id,
        subject_type=row.subject_type,
        subject_id=row.subject_id,
        value=row.value,
        source=row.source,
        note=row.note,
        labeled_by=row.labeled_by,
        labeled_at=row.labeled_at,
    )


def subject_not_found(subject_type: LabelSubjectType) -> ApiError:
    return not_found(f"The {subject_type.value.replace('_', ' ')} to label does not exist")


async def subject_exists(
    session: AsyncSession, subject_type: LabelSubjectType, subject_id: uuid.UUID
) -> bool:
    column = SUBJECT_ID_COLUMNS.get(subject_type)
    if column is None:
        return False
    return bool(await session.scalar(select(exists().where(column == subject_id))))


def label_event_token(row: LabelRow) -> str:
    return f"label:{row.id}:{int(row.labeled_at.timestamp() * 1000)}"


async def reload_label(session: AsyncSession, label_id: uuid.UUID) -> LabelRow:
    return (
        await session.execute(
            select(LabelRow)
            .where(LabelRow.id == label_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def upsert_human_label(
    session: AsyncSession, user_id: uuid.UUID, body: LabelCreate
) -> tuple[LabelRow, bool]:
    statement = insert(LabelRow).values(
        id=new_id(),
        subject_type=body.subject_type,
        subject_id=body.subject_id,
        value=body.value,
        source=LabelSource.human,
        note=body.note,
        labeled_by=user_id,
        labeled_at=func.clock_timestamp(),
    )
    upsert = statement.on_conflict_do_update(
        index_elements=list(CONFLICT_COLUMNS),
        set_={
            "value": statement.excluded.value,
            "note": statement.excluded.note,
            "labeled_at": func.clock_timestamp(),
        },
    ).returning(LabelRow.id, FRESHLY_INSERTED)
    label_id, created = (await session.execute(upsert)).one()
    return await reload_label(session, label_id), bool(created)


async def store_weak_label(
    session: AsyncSession, judge_result_id: uuid.UUID, value: LabelValue
) -> uuid.UUID:
    statement = insert(LabelRow).values(
        id=new_id(),
        subject_type=LabelSubjectType.judge_result,
        subject_id=judge_result_id,
        value=value,
        source=LabelSource.judge_weak,
        note=None,
        labeled_by=None,
        labeled_at=func.clock_timestamp(),
    )
    upsert = statement.on_conflict_do_update(
        index_elements=list(CONFLICT_COLUMNS),
        set_={"value": statement.excluded.value, "labeled_at": func.clock_timestamp()},
    ).returning(LabelRow.id)
    return (await session.execute(upsert)).scalar_one()


async def save_label(session: AsyncSession, user_id: uuid.UUID, body: LabelCreate) -> SavedLabel:
    step: StepRow | None = None
    if body.subject_type is LabelSubjectType.step:
        step = await lock_step(session, body.subject_id)
        if step is None:
            raise subject_not_found(body.subject_type)
    elif not await subject_exists(session, body.subject_type, body.subject_id):
        raise subject_not_found(body.subject_type)
    row, created = await upsert_human_label(session, user_id, body)
    events: list[IngestEvent] = []
    if step is not None:
        events = await refresh_step_verdict(session, step, label_event_token(row))
    await session.commit()
    return SavedLabel(label=to_label(row), created=created, events=announce_label_change(events))


async def delete_own_label(
    session: AsyncSession, user_id: uuid.UUID, label_id: uuid.UUID
) -> list[IngestEvent]:
    row = await session.get(LabelRow, label_id)
    if row is None:
        raise not_found("Label not found")
    if row.source is not LabelSource.human or row.labeled_by != user_id:
        raise forbidden("Only your own human labels can be deleted")
    subject_type, subject_id = row.subject_type, row.subject_id
    step = await lock_step(session, subject_id) if subject_type is LabelSubjectType.step else None
    deleted = await session.execute(
        delete(LabelRow).where(LabelRow.id == label_id).returning(LabelRow.id)
    )
    if deleted.scalar_one_or_none() is None:
        raise not_found("Label not found")
    events: list[IngestEvent] = []
    if step is not None:
        events = await refresh_step_verdict(session, step, f"undo:{label_id}")
    await session.commit()
    return announce_label_change(events)


def label_conditions(filters: LabelFilters) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if filters.subject_types:
        conditions.append(LabelRow.subject_type.in_(list(filters.subject_types)))
    if filters.subject_id is not None:
        conditions.append(LabelRow.subject_id == filters.subject_id)
    if filters.sources:
        conditions.append(LabelRow.source.in_(list(filters.sources)))
    if filters.labeled_by is not None:
        conditions.append(LabelRow.labeled_by == filters.labeled_by)
    return conditions


async def list_labels(session: AsyncSession, query: PageQuery, filters: LabelFilters) -> LabelPage:
    statement = select(LabelRow)
    conditions = label_conditions(filters)
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(session, statement, LABEL_SORT_COLUMNS, LABEL_ID_COLUMN, query)
    return LabelPage(
        items=[to_label(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


def step_machine_status() -> ColumnElement[Any]:
    return func.jsonb_extract_path_text(StepRow.machine_grading, "verdict", "status")


def judge_machine_status() -> ColumnElement[Any]:
    return func.jsonb_extract_path_text(JudgeResultRow.verdict, "status")


def agreement_statement(
    subject_type: LabelSubjectType,
    subject: type[StepRow] | type[JudgeResultRow],
    machine_status: ColumnElement[Any],
) -> Select[int, int]:
    return (
        select(func.count(), func.count().filter(LabelRow.value == machine_status))
        .select_from(LabelRow)
        .join(subject, subject.id == LabelRow.subject_id)
        .where(
            LabelRow.source == LabelSource.human,
            LabelRow.subject_type == subject_type,
            machine_status.in_(LABELABLE_STATUSES),
        )
    )


async def machine_agreement(session: AsyncSession) -> float | None:
    statements = (
        agreement_statement(LabelSubjectType.step, StepRow, step_machine_status()),
        agreement_statement(LabelSubjectType.judge_result, JudgeResultRow, judge_machine_status()),
    )
    compared = 0
    agreed = 0
    for statement in statements:
        total, matching = (await session.execute(statement)).one()
        compared += int(total)
        agreed += int(matching)
    return None if compared == 0 else agreed / compared


async def read_label_stats(session: AsyncSession) -> LabelStats:
    rows = await session.execute(
        select(LabelRow.source, LabelRow.subject_type, func.count()).group_by(
            LabelRow.source, LabelRow.subject_type
        )
    )
    by_subject_type = dict.fromkeys(LabelSubjectType, 0)
    total_human = 0
    total_weak = 0
    for source, subject_type, count in rows:
        if source is LabelSource.human:
            total_human += count
            by_subject_type[subject_type] += count
        else:
            total_weak += count
    return LabelStats(
        total_human=total_human,
        total_weak=total_weak,
        by_subject_type=by_subject_type,
        agreement_with_machine=await machine_agreement(session),
    )


def audit_bucket_expression(step_id: InstrumentedAttribute[uuid.UUID]) -> ColumnElement[Any]:
    digest_prefix = func.substr(func.md5(cast(step_id, Text)), 1, AUDIT_HASH_HEX_DIGITS)
    hex_bits = cast(func.concat(literal("x"), digest_prefix), BIT(AUDIT_HASH_HEX_DIGITS * 4))
    return cast(hex_bits, BigInteger) / literal(float(AUDIT_HASH_SPACE))


def holds_review_reason(reason: LabelReason) -> ColumnElement[bool]:
    return type_coerce(
        StepRow.machine_grading.contains({"review_reasons": [reason.value]}), Boolean
    )


def queue_reason_expression(audit_rate: float) -> ColumnElement[str]:
    audit_selected = and_(
        audit_bucket_expression(StepRow.id) < audit_rate,
        step_machine_status().in_(DECIDED_STATUSES),
    )
    return case(
        (holds_review_reason(LabelReason.judge_flagged), literal(LabelReason.judge_flagged.value)),
        (holds_review_reason(LabelReason.disagreement), literal(LabelReason.disagreement.value)),
        (holds_review_reason(LabelReason.uncertain), literal(LabelReason.uncertain.value)),
        (audit_selected, literal(LabelReason.audit.value)),
        else_=null(),
    )


def unlabeled_by_humans() -> ColumnElement[bool]:
    return not_(
        exists().where(
            LabelRow.subject_type == LabelSubjectType.step,
            LabelRow.subject_id == StepRow.id,
            LabelRow.source == LabelSource.human,
        )
    )


def queue_statement(audit_rate: float, filters: QueueFilters) -> Select[Any]:
    reason = queue_reason_expression(audit_rate)
    conditions: list[ColumnElement[bool]] = [
        StepRow.machine_grading.is_not(None),
        unlabeled_by_humans(),
    ]
    if filters.reasons:
        conditions.append(reason.in_([item.value for item in filters.reasons]))
    else:
        conditions.append(reason.is_not(None))
    if filters.target_id is not None:
        conditions.append(RunRow.target_id == filters.target_id)
    return (
        select(
            StepRow.id.label("step_id"),
            StepRow.run_id.label("run_id"),
            StepRow.label.label("step_label"),
            StepRow.ask.label("ask"),
            StepRow.answer.label("answer"),
            func.jsonb_extract_path_text(StepRow.evidence, "answer").label("evidence_answer"),
            step_machine_status().label("machine_status"),
            cast(
                func.jsonb_extract_path_text(StepRow.machine_grading, "verdict", "confidence"),
                Float,
            ).label("machine_confidence"),
            reason.label("reason"),
            StepRow.finished_at.label("created_at"),
        )
        .join(RunRow, RunRow.id == StepRow.run_id)
        .where(*conditions)
    )


def machine_value_of(status: str | None) -> LabelValue | None:
    return None if status is None else label_value_of(VerdictStatus(status))


def task_excerpt(
    evidence_answer: str | None, answer: str | None, ask: str | None, label: str
) -> str:
    source = evidence_answer or answer or ask or label
    return clip_text(redacted_text(source).strip(), EXCERPT_CHARS)


def task_question(step_label: str) -> str:
    return f'Did the step "{clip_text(step_label, QUESTION_LABEL_CHARS)}" behave correctly?'


def to_label_task(row: Any) -> LabelTask:
    return LabelTask(
        id=f"{LabelSubjectType.step.value}:{row.step_id}",
        subject_type=LabelSubjectType.step,
        subject_id=row.step_id,
        step_id=row.step_id,
        run_id=row.run_id,
        question=task_question(row.step_label),
        machine_value=machine_value_of(row.machine_status),
        machine_confidence=row.machine_confidence,
        evidence_excerpt=task_excerpt(row.evidence_answer, row.answer, row.ask, row.step_label),
        reason=LabelReason(row.reason),
        created_at=row.created_at,
    )


def empty_task_page(query: PageQuery) -> LabelTaskPage:
    return LabelTaskPage(items=[], next_cursor=None, total=0 if query.include_total else None)


async def list_label_queue(
    session: AsyncSession, settings: Settings, query: PageQuery, filters: QueueFilters
) -> LabelTaskPage:
    if filters.subject_types and LabelSubjectType.step not in filters.subject_types:
        return empty_task_page(query)
    thresholds = await resolve_thresholds(session, settings)
    statement = queue_statement(thresholds.label_audit_rate, filters)
    page = await paginate(session, statement, QUEUE_SORT_COLUMNS, QUEUE_ID_COLUMN, query)
    return LabelTaskPage(
        items=[to_label_task(row) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )
