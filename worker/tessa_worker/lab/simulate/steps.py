from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import update
from sqlalchemy.dialects.postgresql import insert

from tessa_api.db.models import StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import AdapterKind, VerdictTier
from tessa_api.schemas.steps import Tier0Result
from tessa_api.schemas.streams import IngestEvent, StepRecordedPayload
from tessa_api.services.grading_rules import MachineGrading
from tessa_worker.adapters.base import StepRecord
from tessa_worker.event_client import build_event

USD_QUANTUM = Decimal("0.000001")
JUDGEMENT_LABEL_LENGTH = 200


def to_money(value: float) -> Decimal:
    return Decimal(str(value)).quantize(USD_QUANTUM)


def step_values(
    run_id: UUID,
    run_scenario_id: UUID,
    attempt: int,
    index: int,
    record: StepRecord,
    tier0: Tier0Result,
) -> dict[str, Any]:
    return {
        "run_scenario_id": run_scenario_id,
        "run_id": run_id,
        "attempt": attempt,
        "index": index,
        "adapter": record.adapter,
        "label": record.label,
        "request": record.request.model_dump(mode="json"),
        "response": None if record.response is None else record.response.model_dump(mode="json"),
        "response_truncated": record.response_truncated,
        "ask": record.ask,
        "answer": record.answer,
        "tools": [tool.model_dump(mode="json") for tool in record.tools],
        "cards": record.cards,
        "tier0": tier0.model_dump(mode="json"),
        "latency_ms": record.latency_ms,
        "cost_usd": to_money(record.cost_usd),
        "artifacts": [],
        "ok": record.ok,
        "tier0_failure_count": len(tier0.failures),
        "screenshot_count": 0,
        "started_at": record.started_at,
        "finished_at": record.finished_at,
    }


async def persist_turn_step(
    session_factory: SessionFactory,
    run_id: UUID,
    run_scenario_id: UUID,
    attempt: int,
    index: int,
    record: StepRecord,
    tier0: Tier0Result,
) -> UUID:
    values = step_values(run_id, run_scenario_id, attempt, index, record, tier0)
    async with session_factory() as session:
        step_id: UUID | None = await session.scalar(
            insert(StepRow)
            .values(id=new_id(), **values)
            .on_conflict_do_update(
                index_elements=[StepRow.run_scenario_id, StepRow.attempt, StepRow.index],
                set_=values,
            )
            .returning(StepRow.id)
        )
        await session.commit()
    if step_id is None:
        raise RuntimeError("the step upsert returned no id")
    return step_id


def step_recorded_event(
    run_id: UUID,
    run_scenario_id: UUID,
    attempt: int,
    index: int,
    step_id: UUID,
    record: StepRecord,
    tier0: Tier0Result,
) -> IngestEvent:
    return build_event(
        run_id,
        "step.recorded",
        StepRecordedPayload(
            step_id=step_id,
            run_scenario_id=run_scenario_id,
            attempt=attempt,
            index=index,
            adapter=record.adapter,
            label=record.label,
            ok=record.ok,
            latency_ms=record.latency_ms,
            cost_usd=record.cost_usd,
            tier0_failure_count=len(tier0.failures),
            screenshot_count=0,
        ),
        f"step.recorded:{run_scenario_id}:{attempt}:{index}",
    )


async def upsert_judgement_step(
    session_factory: SessionFactory,
    run_id: UUID,
    run_scenario_id: UUID,
    attempt: int,
    index: int,
    adapter: AdapterKind,
    label: str,
    ask: str | None,
    answer: str,
) -> UUID:
    now = datetime.now(UTC)
    values: dict[str, Any] = {
        "run_scenario_id": run_scenario_id,
        "run_id": run_id,
        "attempt": attempt,
        "index": index,
        "adapter": adapter,
        "label": label[:JUDGEMENT_LABEL_LENGTH],
        "ask": ask,
        "answer": answer,
        "tier0": Tier0Result(passed=True, failures=[]).model_dump(mode="json"),
        "latency_ms": 0,
        "cost_usd": to_money(0.0),
        "ok": True,
        "tier0_failure_count": 0,
        "screenshot_count": 0,
        "started_at": now,
        "finished_at": now,
    }
    async with session_factory() as session:
        step_id: UUID | None = await session.scalar(
            insert(StepRow)
            .values(id=new_id(), **values)
            .on_conflict_do_update(
                index_elements=[StepRow.run_scenario_id, StepRow.attempt, StepRow.index],
                set_=values,
            )
            .returning(StepRow.id)
        )
        await session.commit()
    if step_id is None:
        raise RuntimeError("the judgement step upsert returned no id")
    return step_id


async def settle_judgement_step(
    session_factory: SessionFactory, step_id: UUID, verdict: Verdict
) -> None:
    grading = MachineGrading(verdict=verdict, escalated_to=VerdictTier.judge, review_reasons=[])
    async with session_factory() as session:
        await session.execute(
            update(StepRow)
            .where(StepRow.id == step_id)
            .values(
                verdict=verdict.model_dump(mode="json"),
                machine_grading=grading.model_dump(mode="json"),
            )
        )
        await session.commit()
