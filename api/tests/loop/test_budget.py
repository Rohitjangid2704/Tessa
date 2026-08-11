import uuid
from decimal import Decimal

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import update

from tessa_api.db.models import ModelCallRow, RunRow
from tessa_api.ids import new_id
from tessa_api.schemas.common import Budget
from tessa_api.schemas.enums import ModelCallRole, ModelCallStatus
from tessa_api.services.budget import (
    BudgetBlockedError,
    UnknownRunError,
    charge_run,
    ensure_affordable,
    read_run_spend,
    remaining_usd,
    to_money,
)
from tests.stage_two.run_support import start_run
from tests.stage_two.support import SeededTarget

pytestmark = pytest.mark.integration


def test_money_is_quantized_to_micro_dollars() -> None:
    assert to_money(0.1) == Decimal("0.100000")
    assert to_money(Decimal("1.2345678")) == Decimal("1.234568")
    assert remaining_usd(Budget(max_usd=1.0, max_minutes=5), Decimal("0.3")) == Decimal("0.700000")


@pytest.fixture
async def run_id(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> uuid.UUID:
    handle = await start_run(client, member_headers, seeded, key="budget-run")
    created = uuid.UUID(handle["run_id"])
    async with db_app.state.session_factory() as session:
        await session.execute(
            update(RunRow)
            .where(RunRow.id == created)
            .values(budget={"max_usd": 1.0, "max_minutes": 10})
        )
        await session.commit()
    return created


async def test_a_call_is_affordable_up_to_the_last_cent_and_blocked_beyond_it(
    db_app: FastAPI, run_id: uuid.UUID
) -> None:
    async with db_app.state.session_factory() as session:
        await ensure_affordable(session, run_id, 1.0)
        await charge_run(session, run_id, Decimal("0.750000"))
        await session.commit()
        await ensure_affordable(session, run_id, 0.25)
        with pytest.raises(BudgetBlockedError) as caught:
            await ensure_affordable(session, run_id, 0.250001)
    assert caught.value.remaining_usd == Decimal("0.250000")
    assert caught.value.requested_usd == Decimal("0.250001")


async def test_charges_add_up_and_blocked_calls_are_counted(
    db_app: FastAPI, run_id: uuid.UUID
) -> None:
    async with db_app.state.session_factory() as session:
        await charge_run(session, run_id, Decimal("0.100000"))
        await charge_run(session, run_id, Decimal("0.025000"))
        for status in (ModelCallStatus.ok, ModelCallStatus.budget_blocked):
            session.add(
                ModelCallRow(
                    id=new_id(),
                    run_id=run_id,
                    role=ModelCallRole.judge,
                    activity="judge_step",
                    model="gpt-test",
                    input_tokens=10,
                    output_tokens=5,
                    cost_usd=Decimal("0"),
                    latency_ms=12,
                    status=status,
                )
            )
        await session.commit()
        spend = await read_run_spend(session, run_id)
    assert spend.spent_usd == Decimal("0.125000")
    assert spend.blocked_calls == 1


async def test_an_unknown_run_is_reported_by_every_ledger_call(
    db_app: FastAPI, run_id: uuid.UUID
) -> None:
    missing = uuid.uuid4()
    async with db_app.state.session_factory() as session:
        with pytest.raises(UnknownRunError):
            await ensure_affordable(session, missing, 0.01)
        with pytest.raises(UnknownRunError):
            await charge_run(session, missing, Decimal("0.01"))
        with pytest.raises(UnknownRunError):
            await read_run_spend(session, missing)
