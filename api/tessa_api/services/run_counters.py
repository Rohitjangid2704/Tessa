from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import RunScenarioRow, StepRow
from tessa_api.schemas.common import RunCounters
from tessa_api.schemas.enums import RunScenarioStatus, VerdictStatus

DONE_SCENARIO_STATUSES = frozenset(
    {
        RunScenarioStatus.finished,
        RunScenarioStatus.skipped,
        RunScenarioStatus.errored,
        RunScenarioStatus.canceled,
    }
)


async def read_run_counters(session: AsyncSession, run_id: UUID) -> RunCounters:
    verdict_status = RunScenarioRow.verdict["status"].as_string().label("verdict_status")
    scenario_rows = await session.execute(
        select(RunScenarioRow.status, verdict_status, func.count())
        .where(RunScenarioRow.run_id == run_id)
        .group_by(RunScenarioRow.status, verdict_status)
    )
    by_verdict: dict[str, int] = {}
    total = 0
    done = 0
    for status, verdict, count in scenario_rows:
        total += count
        if status in DONE_SCENARIO_STATUSES:
            done += count
            if verdict is not None:
                by_verdict[verdict] = by_verdict.get(verdict, 0) + count
    steps = await session.scalar(
        select(func.count()).select_from(StepRow).where(StepRow.run_id == run_id)
    )
    return RunCounters(
        scenarios_total=total,
        scenarios_done=done,
        pass_=by_verdict.get(VerdictStatus.pass_.value, 0),
        fail=by_verdict.get(VerdictStatus.fail.value, 0),
        flaky=by_verdict.get(VerdictStatus.flaky.value, 0),
        uncertain=by_verdict.get(VerdictStatus.uncertain.value, 0),
        skipped=by_verdict.get(VerdictStatus.skipped.value, 0),
        steps_recorded=steps or 0,
    )
