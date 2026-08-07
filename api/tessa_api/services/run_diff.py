from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import RunRow, RunScenarioRow, ScenarioRow
from tessa_api.errors import not_found
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import RunDiffCategory, RunStatus, VerdictStatus
from tessa_api.schemas.run_stats import RunDiff, RunDiffItem
from tessa_api.services.pagination import unknown_parameter_error
from tessa_api.services.run_stats import get_run, read_run_stats, verdict_of

USD_DECIMALS = 6
COMPARABLE_CATEGORIES = frozenset(
    {
        RunDiffCategory.new_failure,
        RunDiffCategory.fixed,
        RunDiffCategory.still_failing,
        RunDiffCategory.flaky_change,
        RunDiffCategory.unchanged,
    }
)

DiffKey = tuple[UUID, str, str]


@dataclass(frozen=True, slots=True)
class DiffRow:
    run_scenario_id: UUID
    scenario_id: UUID
    scenario_version: int
    title: str
    family: str
    role: str
    interface_id: str
    verdict: Verdict | None

    @property
    def key(self) -> DiffKey:
        return (self.scenario_id, self.role, self.interface_id)


def decided_status(verdict: Verdict | None) -> VerdictStatus | None:
    if verdict is None or verdict.status is VerdictStatus.skipped:
        return None
    return verdict.status


def classify_change(before: Verdict | None, after: Verdict | None) -> RunDiffCategory:
    previous = decided_status(before)
    current = decided_status(after)
    if previous is None or current is None:
        return RunDiffCategory.not_comparable
    if VerdictStatus.uncertain in (previous, current):
        return RunDiffCategory.unchanged if previous is current else RunDiffCategory.not_comparable
    if previous is VerdictStatus.fail and current is VerdictStatus.fail:
        return RunDiffCategory.still_failing
    if previous is current:
        return RunDiffCategory.unchanged
    if VerdictStatus.flaky in (previous, current):
        return RunDiffCategory.flaky_change
    return RunDiffCategory.new_failure if previous is VerdictStatus.pass_ else RunDiffCategory.fixed


def categorize(before: DiffRow | None, after: DiffRow | None) -> RunDiffCategory:
    if before is None:
        return RunDiffCategory.added
    if after is None:
        return RunDiffCategory.removed
    if before.scenario_version != after.scenario_version:
        return RunDiffCategory.not_comparable
    return classify_change(before.verdict, after.verdict)


def diff_item(before: DiffRow | None, after: DiffRow | None) -> RunDiffItem:
    source = after or before
    if source is None:
        raise ValueError("a diff item needs a row on at least one side")
    category = categorize(before, after)
    return RunDiffItem(
        scenario_id=source.scenario_id,
        title=source.title,
        family=source.family,
        role=source.role,
        interface_id=source.interface_id,
        run_scenario_id=None if after is None else after.run_scenario_id,
        against_run_scenario_id=None if before is None else before.run_scenario_id,
        before=None if before is None else before.verdict,
        after=None if after is None else after.verdict,
        comparable=category in COMPARABLE_CATEGORIES,
        category=category,
    )


def scenario_ids_in(items: list[RunDiffItem], category: RunDiffCategory) -> list[UUID]:
    return list(
        dict.fromkeys(
            item.scenario_id for item in items if item.comparable and item.category is category
        )
    )


def diff_items(before_rows: list[DiffRow], after_rows: list[DiffRow]) -> list[RunDiffItem]:
    before_by_key = {row.key: row for row in before_rows}
    after_by_key = {row.key: row for row in after_rows}
    keys = list(dict.fromkeys([*after_by_key, *before_by_key]))
    items = [diff_item(before_by_key.get(key), after_by_key.get(key)) for key in keys]
    return sorted(items, key=lambda item: (item.family, item.title, item.role, item.interface_id))


async def load_diff_rows(session: AsyncSession, run_id: UUID) -> list[DiffRow]:
    rows = await session.execute(
        select(
            RunScenarioRow.id,
            RunScenarioRow.scenario_id,
            RunScenarioRow.scenario_version,
            ScenarioRow.title,
            ScenarioRow.family,
            RunScenarioRow.role,
            RunScenarioRow.interface_id,
            RunScenarioRow.verdict,
        )
        .join(ScenarioRow, ScenarioRow.id == RunScenarioRow.scenario_id)
        .where(RunScenarioRow.run_id == run_id)
        .order_by(RunScenarioRow.created_at, RunScenarioRow.id)
    )
    return [
        DiffRow(
            run_scenario_id=row.id,
            scenario_id=row.scenario_id,
            scenario_version=row.scenario_version,
            title=row.title,
            family=row.family,
            role=row.role,
            interface_id=row.interface_id,
            verdict=verdict_of(row.verdict),
        )
        for row in rows
    ]


async def previous_completed_run(session: AsyncSession, run: RunRow) -> RunRow | None:
    if run.plan_id is None:
        return None
    return await session.scalar(
        select(RunRow)
        .where(
            RunRow.plan_id == run.plan_id,
            RunRow.kind == run.kind,
            RunRow.id != run.id,
            RunRow.status == RunStatus.completed,
            RunRow.created_at < run.created_at,
        )
        .order_by(RunRow.created_at.desc(), RunRow.id.desc())
        .limit(1)
    )


async def resolve_against(session: AsyncSession, run: RunRow, against_id: UUID | None) -> RunRow:
    if against_id is None:
        previous = await previous_completed_run(session, run)
        if previous is None:
            raise not_found("No earlier completed run of this plan to compare with")
        return previous
    if against_id == run.id:
        raise unknown_parameter_error("against", "same_run", "A run cannot be compared with itself")
    other = await session.get(RunRow, against_id)
    if other is None:
        raise not_found("Run to compare with not found")
    if other.target_id != run.target_id:
        raise unknown_parameter_error(
            "against", "different_target", "against must be a run of the same target"
        )
    return other


async def build_run_diff(session: AsyncSession, run_id: UUID, against_id: UUID | None) -> RunDiff:
    run = await get_run(session, run_id)
    against = await resolve_against(session, run, against_id)
    items = diff_items(
        await load_diff_rows(session, against.id), await load_diff_rows(session, run.id)
    )
    current_stats = await read_run_stats(session, run.id)
    against_stats = await read_run_stats(session, against.id)
    return RunDiff(
        new_failures=scenario_ids_in(items, RunDiffCategory.new_failure),
        fixed=scenario_ids_in(items, RunDiffCategory.fixed),
        still_failing=scenario_ids_in(items, RunDiffCategory.still_failing),
        flaky_changes=scenario_ids_in(items, RunDiffCategory.flaky_change),
        cost_delta_usd=round(float(run.spent_usd - against.spent_usd), USD_DECIMALS),
        latency_p50_delta_ms=current_stats.latency_ms.p50 - against_stats.latency_ms.p50,
        items=items,
    )
