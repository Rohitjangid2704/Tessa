from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import RunRow, ScheduleRow
from tessa_api.schemas.common import Budget
from tessa_api.schemas.enums import RunTrigger, ScheduleTier
from tessa_api.schemas.runs import RunConfigSnapshot
from tessa_api.services.audit_context import AuthKind, current_audit_context


@dataclass(frozen=True, slots=True)
class ScheduleLink:
    schedule_id: UUID
    tier: ScheduleTier
    budget: Budget | None
    commit_max_minutes: int

    def budget_for(self, planned: Budget) -> Budget:
        chosen = self.budget or planned
        if self.tier is not ScheduleTier.commit:
            return chosen
        return Budget(
            max_usd=chosen.max_usd,
            max_minutes=min(chosen.max_minutes, self.commit_max_minutes),
        )

    def snapshot_for(self, snapshot: RunConfigSnapshot) -> RunConfigSnapshot:
        return snapshot.model_copy(
            update={"schedule_id": self.schedule_id, "schedule_tier": self.tier}
        )

    async def record_run(self, session: AsyncSession, run: RunRow) -> None:
        await session.flush()
        await session.execute(
            update(ScheduleRow).where(ScheduleRow.id == self.schedule_id).values(last_run_id=run.id)
        )


@dataclass(frozen=True, slots=True)
class RunOrigin:
    trigger: RunTrigger = RunTrigger.manual
    run_id: UUID | None = None
    schedule: ScheduleLink | None = None

    def budget_for(self, planned: Budget) -> Budget:
        return planned if self.schedule is None else self.schedule.budget_for(planned)

    def snapshot_for(self, snapshot: RunConfigSnapshot) -> RunConfigSnapshot:
        return snapshot if self.schedule is None else self.schedule.snapshot_for(snapshot)

    async def record_run(self, session: AsyncSession, run: RunRow) -> None:
        if self.schedule is not None:
            await self.schedule.record_run(session, run)


MANUAL_ORIGIN = RunOrigin()
AGENT_ORIGIN = RunOrigin(trigger=RunTrigger.agent)


def origin_for_caller() -> RunOrigin:
    if current_audit_context().auth_kind is AuthKind.personal:
        return AGENT_ORIGIN
    return MANUAL_ORIGIN
