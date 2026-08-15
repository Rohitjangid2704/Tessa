import uuid
from dataclasses import dataclass
from decimal import Decimal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import JudgeResultRow
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import Effort, JudgeFamily, JudgeOrder
from tessa_api.schemas.grading import JudgeEvidence, JudgeStepOutput
from tessa_worker.grading.errors import GradingErrorType, permanent_error
from tessa_worker.grading.judge_verdict import combine_pair_verdicts

JUDGE_RESULT_NAMESPACE = uuid.UUID("5b2f6f0e-3d0e-4d58-9a67-0f6c1e8a7b11")


class JudgeCallRecord(BaseModel):
    order: JudgeOrder
    model: str
    basis: str
    cost_usd: float = Field(ge=0)
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    verdict: Verdict
    rationale: str
    evidence: JudgeEvidence


class JudgeBilling(BaseModel):
    price_table_version: str
    calls: list[JudgeCallRecord]


class StoredJudgeEvidence(JudgeEvidence):
    billing: JudgeBilling


@dataclass(frozen=True, slots=True)
class NewJudgeResult:
    id: uuid.UUID
    step_id: uuid.UUID
    run_id: uuid.UUID
    family: JudgeFamily
    model: str
    effort: Effort
    rubric_version: str
    verdict: Verdict
    call: JudgeCallRecord
    price_table_version: str


def deterministic_result_id(
    step_id: uuid.UUID, family: JudgeFamily, order: JudgeOrder
) -> uuid.UUID:
    return uuid.uuid5(JUDGE_RESULT_NAMESPACE, f"{step_id}:{family.value}:{order.value}")


def stored_evidence(row: JudgeResultRow) -> StoredJudgeEvidence:
    return StoredJudgeEvidence.model_validate(row.evidence)


def call_for_order(row: JudgeResultRow, order: JudgeOrder) -> JudgeCallRecord | None:
    return next((call for call in stored_evidence(row).billing.calls if call.order is order), None)


def output_from_call(
    row: JudgeResultRow, call: JudgeCallRecord, swapped_agrees: bool | None
) -> JudgeStepOutput:
    verdict = Verdict.model_validate(row.verdict) if swapped_agrees is not None else call.verdict
    return JudgeStepOutput(
        cost_usd=call.cost_usd,
        input_tokens=call.input_tokens,
        output_tokens=call.output_tokens,
        verdict=verdict,
        rationale=call.rationale,
        evidence=call.evidence,
        judge_result_id=row.id,
        swapped_agrees=swapped_agrees,
    )


def swapped_agrees_of(row: JudgeResultRow) -> bool | None:
    if row.pairwise is None:
        return None
    return bool(row.pairwise["swapped_agrees"])


async def load_result(session: AsyncSession, result_id: uuid.UUID) -> JudgeResultRow | None:
    return await session.get(JudgeResultRow, result_id)


async def replay_first_call(
    session: AsyncSession, result_id: uuid.UUID, order: JudgeOrder
) -> JudgeStepOutput | None:
    row = await load_result(session, result_id)
    if row is None:
        return None
    call = call_for_order(row, order)
    return None if call is None else output_from_call(row, call, None)


async def replay_swapped_call(
    session: AsyncSession, paired_id: uuid.UUID, order: JudgeOrder
) -> JudgeStepOutput | None:
    row = await load_result(session, paired_id)
    if row is None or row.pairwise is None:
        return None
    call = call_for_order(row, order)
    return None if call is None else output_from_call(row, call, swapped_agrees_of(row))


def result_values(new: NewJudgeResult) -> dict[str, object]:
    evidence = StoredJudgeEvidence(
        gold_points=new.call.evidence.gold_points,
        must_not_claim=new.call.evidence.must_not_claim,
        unsupported_claims=new.call.evidence.unsupported_claims,
        billing=JudgeBilling(price_table_version=new.price_table_version, calls=[new.call]),
    )
    return {
        "id": new.id,
        "step_id": new.step_id,
        "run_id": new.run_id,
        "family": new.family,
        "model": new.model,
        "effort": new.effort,
        "rubric_version": new.rubric_version,
        "verdict": new.verdict.model_dump(mode="json"),
        "pairwise": None,
        "evidence": evidence.model_dump(mode="json"),
        "cost_usd": Decimal(str(new.call.cost_usd)),
    }


async def insert_first_call(session: AsyncSession, new: NewJudgeResult) -> bool:
    statement = (
        insert(JudgeResultRow)
        .values(**result_values(new))
        .on_conflict_do_nothing(index_elements=[JudgeResultRow.id])
        .returning(JudgeResultRow.id)
    )
    inserted = (await session.execute(statement)).scalar_one_or_none()
    await session.commit()
    return inserted is not None


async def locked_pair_row(
    session: AsyncSession, paired_id: uuid.UUID, step_id: uuid.UUID
) -> JudgeResultRow:
    row = await session.scalar(
        select(JudgeResultRow).where(JudgeResultRow.id == paired_id).with_for_update()
    )
    if row is None or row.step_id != step_id or row.family is not JudgeFamily.openai:
        raise permanent_error(
            GradingErrorType.paired_result_not_found,
            f"judge result {paired_id} is not the first order result of step {step_id}",
        )
    return row


async def complete_pair(
    session: AsyncSession,
    paired_id: uuid.UUID,
    step_id: uuid.UUID,
    call: JudgeCallRecord,
    stub: bool,
) -> JudgeStepOutput:
    row = await locked_pair_row(session, paired_id, step_id)
    existing = call_for_order(row, call.order)
    if existing is not None and row.pairwise is not None:
        await session.rollback()
        return output_from_call(row, existing, swapped_agrees_of(row))
    evidence = stored_evidence(row)
    combined, agrees = combine_pair_verdicts(evidence.billing.calls[0].verdict, call.verdict, stub)
    evidence.billing.calls.append(call)
    row.evidence = evidence.model_dump(mode="json")
    row.verdict = combined.model_dump(mode="json")
    row.pairwise = {"swapped_agrees": agrees}
    row.cost_usd = row.cost_usd + Decimal(str(call.cost_usd))
    await session.commit()
    return output_from_call(row, call, agrees)


async def require_first_order_result(
    session: AsyncSession, paired_id: uuid.UUID, step_id: uuid.UUID
) -> None:
    row = await load_result(session, paired_id)
    if row is None or row.step_id != step_id or row.family is not JudgeFamily.openai:
        raise permanent_error(
            GradingErrorType.paired_result_not_found,
            f"judge result {paired_id} is not the first order result of step {step_id}",
        )
