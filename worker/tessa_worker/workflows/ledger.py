from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from tessa_api.schemas.common import Budget, BudgetState
from tessa_api.schemas.streams import BudgetExhaustedPayload

MILLISECONDS_PER_MINUTE = 60_000
USD_DECIMALS = 6
BUDGET_POLL_INTERVAL = timedelta(seconds=5)

BudgetDimension = Literal["usd", "minutes"]


@dataclass(slots=True)
class BudgetLedger:
    budget: Budget
    started_at: datetime
    spent_usd: float = 0.0
    blocked_calls: int = 0

    def elapsed_ms(self, now: datetime) -> int:
        return max(0, round((now - self.started_at).total_seconds() * 1000))

    def seconds_left(self, now: datetime) -> float:
        limit_ms = self.budget.max_minutes * MILLISECONDS_PER_MINUTE
        return (limit_ms - self.elapsed_ms(now)) / 1000

    def observe(self, spent_usd: float, blocked_calls: int) -> None:
        self.spent_usd = max(self.spent_usd, round(spent_usd, USD_DECIMALS))
        self.blocked_calls = max(self.blocked_calls, blocked_calls)

    def usd_exhausted(self) -> bool:
        return self.spent_usd > self.budget.max_usd or self.blocked_calls > 0

    def state(self, now: datetime) -> BudgetState:
        return BudgetState(
            max_usd=self.budget.max_usd,
            spent_usd=self.spent_usd,
            max_minutes=self.budget.max_minutes,
            elapsed_ms=self.elapsed_ms(now),
        )

    def exhaustion(self, dimension: BudgetDimension, now: datetime) -> BudgetExhaustedPayload:
        if dimension == "usd":
            return BudgetExhaustedPayload(
                dimension="usd", limit=self.budget.max_usd, actual=self.spent_usd
            )
        return BudgetExhaustedPayload(
            dimension="minutes",
            limit=float(self.budget.max_minutes),
            actual=round(self.elapsed_ms(now) / MILLISECONDS_PER_MINUTE, 3),
        )
