import logging
import uuid
from collections.abc import Sequence

from pydantic import JsonValue, TypeAdapter, ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import OracleResultRow, StepRow
from tessa_api.schemas.oracles import DbCheck, GoldPoint
from tessa_api.schemas.steps import StepRequestUnion, StepResponseUnion, StepTool, Tier0Result
from tessa_worker.activities.tier0 import permanent
from tessa_worker.invariants.contracts import InvariantStep

logger = logging.getLogger("tessa_worker.invariants")

REQUEST_ADAPTER: TypeAdapter[StepRequestUnion] = TypeAdapter(StepRequestUnion)
RESPONSE_ADAPTER: TypeAdapter[StepResponseUnion] = TypeAdapter(StepResponseUnion)
TOOLS_ADAPTER: TypeAdapter[list[StepTool]] = TypeAdapter(list[StepTool])
GOLD_ADAPTER: TypeAdapter[list[GoldPoint]] = TypeAdapter(list[GoldPoint])
DB_CHECKS_ADAPTER: TypeAdapter[list[DbCheck]] = TypeAdapter(list[DbCheck])


def parsed_or_none[Value](
    adapter: TypeAdapter[Value], raw: object, step_id: uuid.UUID, what: str
) -> Value | None:
    if raw is None:
        return None
    try:
        return adapter.validate_python(raw)
    except ValidationError:
        logger.warning(
            "invariant_step_field_unreadable", extra={"step_id": str(step_id), "field": what}
        )
        return None


def parsed_list[Value](
    adapter: TypeAdapter[list[Value]], raw: object, step_id: uuid.UUID, what: str
) -> list[Value]:
    return parsed_or_none(adapter, raw, step_id, what) or []


def tier0_of(row: StepRow) -> Tier0Result:
    try:
        return Tier0Result.model_validate(row.tier0)
    except ValidationError:
        raise permanent(f"step {row.id} holds an unreadable Tier-0 result") from None


def cards_of(row: StepRow) -> list[dict[str, JsonValue]]:
    return [dict(card) for card in row.cards if isinstance(card, dict)]


def to_invariant_step(row: StepRow, oracle_row_counts: dict[uuid.UUID, int]) -> InvariantStep:
    gold_points = parsed_list(GOLD_ADAPTER, row.gold_points, row.id, "gold_points")
    return InvariantStep(
        step_id=row.id,
        index=row.index,
        attempt=row.attempt,
        adapter=row.adapter,
        label=row.label,
        ok=row.ok,
        request=parsed_or_none(REQUEST_ADAPTER, row.request, row.id, "request"),
        response=parsed_or_none(RESPONSE_ADAPTER, row.response, row.id, "response"),
        ask=row.ask,
        answer=row.answer,
        tools=parsed_list(TOOLS_ADAPTER, row.tools, row.id, "tools"),
        cards=cards_of(row),
        latency_ms=row.latency_ms,
        tier0=tier0_of(row),
        gold_points=gold_points,
        db_checks=parsed_list(DB_CHECKS_ADAPTER, row.db_checks, row.id, "db_checks"),
        oracle_row_counts={
            point.oracle_result_id: oracle_row_counts[point.oracle_result_id]
            for point in gold_points
            if point.oracle_result_id in oracle_row_counts
        },
    )


async def load_oracle_row_counts(
    session: AsyncSession, rows: Sequence[StepRow]
) -> dict[uuid.UUID, int]:
    wanted = {
        uuid.UUID(str(point["oracle_result_id"]))
        for row in rows
        for point in row.gold_points
        if isinstance(point, dict) and point.get("oracle_result_id")
    }
    if not wanted:
        return {}
    counted = await session.execute(
        select(OracleResultRow.id, func.jsonb_array_length(OracleResultRow.rows)).where(
            OracleResultRow.id.in_(wanted), OracleResultRow.rows_truncated.is_(False)
        )
    )
    return dict(counted.tuples().all())


async def load_invariant_steps(
    session: AsyncSession, run_scenario_id: uuid.UUID, attempt: int | None
) -> list[InvariantStep]:
    statement = select(StepRow).where(StepRow.run_scenario_id == run_scenario_id)
    if attempt is not None:
        statement = statement.where(StepRow.attempt == attempt)
    rows = list((await session.scalars(statement.order_by(StepRow.attempt, StepRow.index))).all())
    counts = await load_oracle_row_counts(session, rows)
    return [to_invariant_step(row, counts) for row in rows]
