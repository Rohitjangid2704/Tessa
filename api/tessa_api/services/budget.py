from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import ModelCallRow, RunRow
from tessa_api.schemas.common import Budget
from tessa_api.schemas.enums import ModelCallStatus

USD_QUANTUM = Decimal("0.000001")


class UnknownRunError(LookupError):
    def __init__(self, run_id: UUID) -> None:
        super().__init__(f"run {run_id} does not exist")
        self.run_id = run_id


class BudgetBlockedError(Exception):
    def __init__(self, run_id: UUID, remaining_usd: Decimal, requested_usd: Decimal) -> None:
        super().__init__(
            f"run {run_id} has {remaining_usd} USD left, the call may cost {requested_usd} USD"
        )
        self.run_id = run_id
        self.remaining_usd = remaining_usd
        self.requested_usd = requested_usd


@dataclass(frozen=True, slots=True)
class RunSpend:
    spent_usd: Decimal
    blocked_calls: int


def to_money(value: float | Decimal) -> Decimal:
    return Decimal(str(value)).quantize(USD_QUANTUM)


def remaining_usd(budget: Budget, spent_usd: Decimal) -> Decimal:
    return to_money(budget.max_usd) - spent_usd


async def ensure_affordable(session: AsyncSession, run_id: UUID, max_usd: float) -> None:
    row = (
        await session.execute(select(RunRow.budget, RunRow.spent_usd).where(RunRow.id == run_id))
    ).first()
    if row is None:
        raise UnknownRunError(run_id)
    remaining = remaining_usd(Budget.model_validate(row.budget), row.spent_usd)
    requested = to_money(max_usd)
    if remaining < requested:
        raise BudgetBlockedError(run_id, remaining, requested)


async def charge_run(session: AsyncSession, run_id: UUID, cost_usd: Decimal) -> None:
    charged = await session.scalar(
        update(RunRow)
        .where(RunRow.id == run_id)
        .values(spent_usd=RunRow.spent_usd + cost_usd)
        .returning(RunRow.id)
        .execution_options(synchronize_session=False)
    )
    if charged is None:
        raise UnknownRunError(run_id)


async def read_run_spend(session: AsyncSession, run_id: UUID) -> RunSpend:
    spent = await session.scalar(select(RunRow.spent_usd).where(RunRow.id == run_id))
    if spent is None:
        raise UnknownRunError(run_id)
    blocked = await session.scalar(
        select(func.count())
        .select_from(ModelCallRow)
        .where(ModelCallRow.run_id == run_id, ModelCallRow.status == ModelCallStatus.budget_blocked)
    )
    return RunSpend(spent_usd=spent, blocked_calls=blocked or 0)
