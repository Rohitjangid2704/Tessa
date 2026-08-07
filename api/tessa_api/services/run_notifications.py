from collections.abc import Sequence
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import FindingOccurrenceRow, FindingRow, MutationRunRow, ScheduleRow
from tessa_api.schemas.enums import (
    FindingStatus,
    MutationOutcome,
    ReportChannel,
    RunDiffCategory,
)
from tessa_api.schemas.notification_plans import PlannedNotification
from tessa_api.schemas.reports import RunReport
from tessa_api.schemas.run_stats import RunDiff
from tessa_api.schemas.runs import Run
from tessa_api.schemas.schedules import ScheduleNotify
from tessa_api.services.findings.queries import SEVERITY_RANK_EXPRESSION
from tessa_api.services.notification_channels import resolve_channel_state
from tessa_api.services.notification_rules import (
    ChannelContext,
    FindingBrief,
    RunFacts,
    ScheduleFacts,
    plan_notifications,
)
from tessa_api.services.reports import build_run_report
from tessa_api.services.vault import Vault
from tessa_api.settings import StrictSettings

MILLISECONDS_PER_MINUTE = 60_000


def notify_of(blob: dict[str, object]) -> ScheduleNotify:
    try:
        return ScheduleNotify.model_validate(blob)
    except ValidationError:
        return ScheduleNotify()


async def load_schedule_facts(session: AsyncSession, run: Run) -> ScheduleFacts | None:
    snapshot = run.config_snapshot
    if snapshot.schedule_id is None:
        return None
    row = await session.get(ScheduleRow, snapshot.schedule_id)
    if row is not None:
        return ScheduleFacts(tier=row.tier, notify=notify_of(row.notify))
    if snapshot.schedule_tier is None:
        return None
    return ScheduleFacts(tier=snapshot.schedule_tier, notify=ScheduleNotify())


async def load_regressed_findings(session: AsyncSession, run: Run) -> tuple[FindingBrief, ...]:
    window_start = run.started_at or run.created_at
    rows = await session.execute(
        select(FindingRow.id, FindingRow.title, FindingRow.severity)
        .where(
            FindingRow.status == FindingStatus.new,
            FindingRow.first_seen_run_id != run.id,
            FindingRow.status_changed_at >= window_start,
            exists().where(
                FindingOccurrenceRow.finding_id == FindingRow.id,
                FindingOccurrenceRow.run_id == run.id,
            ),
        )
        .order_by(SEVERITY_RANK_EXPRESSION.desc(), FindingRow.id)
    )
    return tuple(FindingBrief(row.id, row.title, row.severity) for row in rows)


async def load_survived_invariants(session: AsyncSession, run: Run) -> tuple[str, ...]:
    outcomes = await session.scalar(
        select(MutationRunRow.outcomes).where(MutationRunRow.run_id == run.id)
    )
    survived = MutationOutcome.survived.value
    return tuple(
        str(item["invariant_id"])
        for item in outcomes or []
        if item.get("outcome") == survived and "invariant_id" in item
    )


def new_finding_count(report: RunReport) -> int:
    window_start = report.run.started_at or report.run.created_at
    return sum(1 for finding in report.findings if finding.first_seen_at >= window_start)


def titles_in(diff: RunDiff | None, category: RunDiffCategory) -> tuple[str, ...]:
    if diff is None:
        return ()
    titles = (item.title for item in diff.items if item.comparable and item.category is category)
    return tuple(dict.fromkeys(titles))


def build_run_facts(
    report: RunReport,
    schedule: ScheduleFacts | None,
    regressed: tuple[FindingBrief, ...],
    survived: tuple[str, ...],
) -> RunFacts:
    run = report.run
    diff = report.diff
    return RunFacts(
        run_id=run.id,
        kind=run.kind,
        status=run.status,
        trigger=run.trigger,
        counters=run.counters,
        pass_hat_k=report.stats.pass_hat_k,
        spent_usd=run.budget.spent_usd,
        max_usd=run.budget.max_usd,
        max_minutes=run.budget.max_minutes,
        elapsed_minutes=run.budget.elapsed_ms // MILLISECONDS_PER_MINUTE,
        new_failures=None if diff is None else len(diff.new_failures),
        fixed=None if diff is None else len(diff.fixed),
        new_failure_titles=titles_in(diff, RunDiffCategory.new_failure),
        fixed_titles=titles_in(diff, RunDiffCategory.fixed),
        finding_count=len(report.findings),
        new_finding_count=new_finding_count(report),
        regressed=regressed,
        survived_invariants=survived,
        schedule=schedule,
    )


async def load_run_facts(session: AsyncSession, report: RunReport) -> RunFacts:
    run = report.run
    return build_run_facts(
        report,
        await load_schedule_facts(session, run),
        await load_regressed_findings(session, run),
        await load_survived_invariants(session, run),
    )


async def plan_run_notifications(
    session: AsyncSession,
    vault: Vault,
    settings: StrictSettings,
    run_id: UUID,
    requested: Sequence[ReportChannel],
) -> list[PlannedNotification]:
    report = await build_run_report(session, run_id)
    facts = await load_run_facts(session, report)
    state = await resolve_channel_state(session, vault, settings)
    context = ChannelContext(
        requested=frozenset(requested),
        slack_ready=state.slack_ready,
        schedule_notify=None if facts.schedule is None else facts.schedule.notify,
    )
    return plan_notifications(facts, context, settings.report_base_url)
