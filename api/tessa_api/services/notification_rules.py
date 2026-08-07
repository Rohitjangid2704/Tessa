from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID

from tessa_api.schemas.common import RunCounters
from tessa_api.schemas.enums import (
    NotificationKind,
    ReportChannel,
    RunKind,
    RunStatus,
    RunTrigger,
    ScheduleTier,
    SecretName,
    Severity,
)
from tessa_api.schemas.notification_plans import PlannedNotification
from tessa_api.schemas.notifications import (
    NOTIFICATION_BODY_MAX_LENGTH,
    NOTIFICATION_TITLE_MAX_LENGTH,
    NotificationContent,
)
from tessa_api.schemas.schedules import ScheduleNotify
from tessa_api.schemas.temporal import SLACK_TEXT_MAX_CHARS, SlackMessage
from tessa_api.services.findings.severity import SEVERITY_RANK

TERMINAL_STATUSES = frozenset(
    {RunStatus.completed, RunStatus.failed, RunStatus.canceled, RunStatus.budget_exceeded}
)
SUMMARY_TIERS = frozenset({ScheduleTier.nightly, ScheduleTier.weekly})
INTERACTIVE_TRIGGERS = frozenset({RunTrigger.manual, RunTrigger.agent})
TIER_LABELS = {
    ScheduleTier.nightly: "Nightly",
    ScheduleTier.weekly: "Weekly",
    ScheduleTier.commit: "Commit",
}
STATUS_PHRASES = {
    RunStatus.completed: "finished",
    RunStatus.failed: "failed",
    RunStatus.canceled: "was canceled",
    RunStatus.budget_exceeded: "stopped at its budget",
}
LISTED_ITEMS_MAX = 10
LISTED_CHANGES_MAX = 5
CLIP_SUFFIX = "..."


class Audience(StrEnum):
    routine = "routine"
    alert = "alert"


@dataclass(frozen=True, slots=True)
class FindingBrief:
    finding_id: UUID
    title: str
    severity: Severity


@dataclass(frozen=True, slots=True)
class ScheduleFacts:
    tier: ScheduleTier
    notify: ScheduleNotify


@dataclass(frozen=True, slots=True)
class RunFacts:
    run_id: UUID
    kind: RunKind
    status: RunStatus
    trigger: RunTrigger
    counters: RunCounters
    pass_hat_k: float | None
    spent_usd: float
    max_usd: float
    max_minutes: int
    elapsed_minutes: int
    new_failures: int | None
    fixed: int | None
    new_failure_titles: tuple[str, ...]
    fixed_titles: tuple[str, ...]
    finding_count: int
    new_finding_count: int
    regressed: tuple[FindingBrief, ...]
    survived_invariants: tuple[str, ...]
    schedule: ScheduleFacts | None


@dataclass(frozen=True, slots=True)
class RuleHit:
    content: NotificationContent
    audience: Audience


@dataclass(frozen=True, slots=True)
class ChannelContext:
    requested: frozenset[ReportChannel]
    slack_ready: bool
    schedule_notify: ScheduleNotify | None


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - len(CLIP_SUFFIX)].rstrip() + CLIP_SUFFIX


def plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def percent(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.0f}%"


def run_link(run_id: UUID) -> str:
    return f"/runs/{run_id}"


def finding_link(finding_id: UUID) -> str:
    return f"/findings/{finding_id}"


def absolute_link(base_url: str, link: str) -> str:
    return f"{base_url.rstrip('/')}{link}"


def build_content(
    kind: NotificationKind,
    severity: Severity,
    title: str,
    lines: Sequence[str],
    link: str,
    run_id: UUID,
) -> NotificationContent:
    return NotificationContent(
        kind=kind,
        severity=severity,
        title=clip(title, NOTIFICATION_TITLE_MAX_LENGTH),
        body=clip("\n".join(lines), NOTIFICATION_BODY_MAX_LENGTH),
        link=link,
        run_id=run_id,
    )


def highest_severity(severities: Sequence[Severity]) -> Severity:
    return max(severities, key=lambda severity: SEVERITY_RANK[severity])


def summary_severity(facts: RunFacts) -> Severity:
    if facts.status is RunStatus.failed:
        return Severity.high
    if facts.status is RunStatus.canceled:
        return Severity.info
    if facts.counters.fail > 0:
        return Severity.high if (facts.new_failures or 0) > 0 else Severity.medium
    if facts.counters.flaky > 0 or facts.counters.uncertain > 0:
        return Severity.low
    return Severity.info


def is_scheduled(facts: RunFacts) -> bool:
    return facts.schedule is not None or facts.trigger is RunTrigger.schedule


def summary_kind(facts: RunFacts) -> NotificationKind | None:
    if facts.kind is not RunKind.suite:
        return None
    if not is_scheduled(facts) and facts.trigger in INTERACTIVE_TRIGGERS:
        return None
    if is_scheduled(facts) and facts.status is RunStatus.failed:
        return None
    if facts.schedule is not None and facts.schedule.tier in SUMMARY_TIERS:
        return NotificationKind.nightly_summary
    return NotificationKind.run_finished


def counters_line(counters: RunCounters) -> str:
    return (
        f"Scenarios: {counters.scenarios_done} of {counters.scenarios_total} done "
        f"(pass {counters.pass_}, fail {counters.fail}, flaky {counters.flaky}, "
        f"uncertain {counters.uncertain}, skipped {counters.skipped})"
    )


def comparison_line(facts: RunFacts) -> str | None:
    if facts.new_failures is None:
        return None
    return (
        f"Against the previous run: {plural(facts.new_failures, 'new failure')}, "
        f"{facts.fixed or 0} fixed"
    )


def findings_line(facts: RunFacts) -> str | None:
    if facts.finding_count == 0:
        return None
    return f"Findings seen in this run: {facts.finding_count} ({facts.new_finding_count} new)"


def cost_line(facts: RunFacts) -> str:
    return f"Cost: ${facts.spent_usd:.2f} of ${facts.max_usd:.2f}"


def summary_title(facts: RunFacts, kind: NotificationKind) -> str:
    label = "Run"
    if kind is NotificationKind.nightly_summary and facts.schedule is not None:
        label = f"{TIER_LABELS[facts.schedule.tier]} run"
    phrase = STATUS_PHRASES.get(facts.status, facts.status.value)
    title = f"{label} {phrase}: pass^k {percent(facts.pass_hat_k)}"
    if facts.new_failures:
        title += f", {plural(facts.new_failures, 'new failure')}"
    elif facts.counters.fail:
        title += f", {facts.counters.fail} failing"
    return title


def change_lines(heading: str, titles: Sequence[str]) -> list[str]:
    if not titles:
        return []
    listed = [f"- {title}" for title in titles[:LISTED_CHANGES_MAX]]
    hidden = len(titles) - LISTED_CHANGES_MAX
    return [f"{heading}:", *listed, *([f"and {hidden} more"] if hidden > 0 else [])]


def summary_lines(facts: RunFacts) -> list[str]:
    summary = [counters_line(facts.counters)]
    for line in (comparison_line(facts), findings_line(facts)):
        if line is not None:
            summary.append(line)
    summary += change_lines("New failures", facts.new_failure_titles)
    summary += change_lines("Fixed", facts.fixed_titles)
    summary.append(cost_line(facts))
    return summary


def summary_hit(facts: RunFacts) -> RuleHit | None:
    kind = summary_kind(facts)
    if kind is None:
        return None
    lines = summary_lines(facts)
    content = build_content(
        kind,
        summary_severity(facts),
        summary_title(facts, kind),
        lines,
        run_link(facts.run_id),
        facts.run_id,
    )
    return RuleHit(content, Audience.routine)


def regression_lines(regressed: Sequence[FindingBrief]) -> list[str]:
    listed = [f"- [{brief.severity.value}] {brief.title}" for brief in regressed[:LISTED_ITEMS_MAX]]
    hidden = len(regressed) - LISTED_ITEMS_MAX
    return listed + ([f"and {hidden} more"] if hidden > 0 else [])


def regression_hit(facts: RunFacts) -> RuleHit | None:
    if not facts.regressed:
        return None
    link = (
        finding_link(facts.regressed[0].finding_id)
        if len(facts.regressed) == 1
        else run_link(facts.run_id)
    )
    content = build_content(
        NotificationKind.finding_regression,
        highest_severity([brief.severity for brief in facts.regressed]),
        f"{plural(len(facts.regressed), 'resolved finding')} came back",
        regression_lines(facts.regressed),
        link,
        facts.run_id,
    )
    return RuleHit(content, Audience.alert)


def budget_hit(facts: RunFacts) -> RuleHit | None:
    if facts.status is not RunStatus.budget_exceeded:
        return None
    lines = [
        f"Spent ${facts.spent_usd:.2f} of ${facts.max_usd:.2f}.",
        f"Ran {facts.elapsed_minutes} of {facts.max_minutes} minutes.",
        f"{facts.counters.scenarios_done} of {facts.counters.scenarios_total} scenarios finished.",
    ]
    content = build_content(
        NotificationKind.budget_exceeded,
        Severity.medium,
        "Run stopped: budget exhausted",
        lines,
        run_link(facts.run_id),
        facts.run_id,
    )
    return RuleHit(content, Audience.alert)


def survivor_hit(facts: RunFacts) -> RuleHit | None:
    if facts.kind is not RunKind.mutation or not facts.survived_invariants:
        return None
    lines = [f"- {invariant_id}" for invariant_id in facts.survived_invariants[:LISTED_ITEMS_MAX]]
    hidden = len(facts.survived_invariants) - LISTED_ITEMS_MAX
    missed_by = plural(len(facts.survived_invariants), "invariant")
    content = build_content(
        NotificationKind.mutant_survived,
        Severity.high,
        f"A mutant survived: {missed_by} did not catch it",
        lines + ([f"and {hidden} more"] if hidden > 0 else []),
        run_link(facts.run_id),
        facts.run_id,
    )
    return RuleHit(content, Audience.alert)


def schedule_failure_hit(facts: RunFacts) -> RuleHit | None:
    if not is_scheduled(facts) or facts.status is not RunStatus.failed:
        return None
    label = "Scheduled"
    if facts.schedule is not None:
        label = f"{TIER_LABELS[facts.schedule.tier]} scheduled"
    content = build_content(
        NotificationKind.schedule_failed,
        Severity.high,
        f"{label} run failed to execute",
        [counters_line(facts.counters), cost_line(facts)],
        run_link(facts.run_id),
        facts.run_id,
    )
    return RuleHit(content, Audience.alert)


def evaluate_rules(facts: RunFacts) -> list[RuleHit]:
    if facts.status not in TERMINAL_STATUSES:
        return []
    candidates = (
        summary_hit(facts),
        regression_hit(facts),
        budget_hit(facts),
        survivor_hit(facts),
        schedule_failure_hit(facts),
    )
    return [hit for hit in candidates if hit is not None]


def wants_slack(audience: Audience, context: ChannelContext) -> bool:
    if ReportChannel.slack not in context.requested or not context.slack_ready:
        return False
    if context.schedule_notify is not None:
        return context.schedule_notify.slack
    return audience is Audience.alert


def slack_message(content: NotificationContent, base_url: str) -> SlackMessage:
    head = f"[{content.severity.value}] {content.title}"
    text = head if not content.body else f"{head}\n{content.body}"
    return SlackMessage(
        webhook_ref=SecretName.slack_webhook_url,
        text=clip(text, SLACK_TEXT_MAX_CHARS),
        link=absolute_link(base_url, content.link),
    )


def plan_hit(hit: RuleHit, context: ChannelContext, base_url: str) -> PlannedNotification:
    return PlannedNotification(
        content=hit.content,
        slack=slack_message(hit.content, base_url) if wants_slack(hit.audience, context) else None,
    )


def plan_notifications(
    facts: RunFacts, context: ChannelContext, base_url: str
) -> list[PlannedNotification]:
    return [plan_hit(hit, context, base_url) for hit in evaluate_rules(facts)]
