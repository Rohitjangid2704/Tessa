import functools
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined, Template

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import (
    RunDiffCategory,
    RunStatus,
    Severity,
    VerdictStatus,
)
from tessa_api.schemas.findings import FindingSummary
from tessa_api.schemas.reports import RunReport
from tessa_api.schemas.run_stats import FamilyStats, InvariantStats, RunDiff, RunDiffItem

TEMPLATE_DIRECTORY = Path(__file__).resolve().parent / "report_templates"
TEMPLATE_NAME = "run_report.html.j2"
DIFF_ROWS_MAX = 200
FINDING_ROWS_MAX = 200
REASON_MAX_CHARS = 240
CLIP_SUFFIX = "..."
NOT_AVAILABLE = "n/a"
SHOWN_DIFF_CATEGORIES = frozenset(
    {
        RunDiffCategory.new_failure,
        RunDiffCategory.fixed,
        RunDiffCategory.still_failing,
        RunDiffCategory.flaky_change,
        RunDiffCategory.added,
        RunDiffCategory.removed,
    }
)
DIFF_CATEGORY_LABELS = {
    RunDiffCategory.new_failure: "New failure",
    RunDiffCategory.fixed: "Fixed",
    RunDiffCategory.still_failing: "Still failing",
    RunDiffCategory.flaky_change: "Flakiness changed",
    RunDiffCategory.added: "Added",
    RunDiffCategory.removed: "Removed",
}
DIFF_CATEGORY_TONES = {
    RunDiffCategory.new_failure: "bad",
    RunDiffCategory.fixed: "ok",
    RunDiffCategory.still_failing: "bad",
    RunDiffCategory.flaky_change: "warn",
    RunDiffCategory.added: "info",
    RunDiffCategory.removed: "info",
}
STATUS_TONES = {
    RunStatus.completed: "ok",
    RunStatus.failed: "bad",
    RunStatus.canceled: "muted",
    RunStatus.budget_exceeded: "warn",
}
VERDICT_TONES = {
    VerdictStatus.pass_: "ok",
    VerdictStatus.fail: "bad",
    VerdictStatus.flaky: "warn",
    VerdictStatus.uncertain: "warn",
    VerdictStatus.skipped: "muted",
}
SEVERITY_ORDER = (
    Severity.critical,
    Severity.high,
    Severity.medium,
    Severity.low,
    Severity.info,
)


@dataclass(frozen=True, slots=True)
class Cell:
    text: str
    css: str = ""
    href: str | None = None
    badge: bool = False
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class Table:
    headers: tuple[str, ...]
    rows: tuple[tuple[Cell, ...], ...]
    omitted: int = 0


@dataclass(frozen=True, slots=True)
class Section:
    heading: str
    table: Table | None
    empty: str
    note: str | None = None


@dataclass(frozen=True, slots=True)
class Tile:
    label: str
    value: str
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class ReportView:
    title: str
    status: str
    status_css: str
    subtitle: str
    run_url: str
    generated_at: str
    tiles: tuple[Tile, ...]
    sections: tuple[Section, ...]


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - len(CLIP_SUFFIX)].rstrip() + CLIP_SUFFIX


def format_time(value: datetime | None) -> str:
    if value is None:
        return NOT_AVAILABLE
    return value.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def format_percent(value: float | None) -> str:
    return NOT_AVAILABLE if value is None else f"{value * 100:.0f}%"


def format_usd(value: float) -> str:
    return f"${value:.4f}" if 0 < value < 0.01 else f"${value:,.2f}"


def format_signed(value: float, unit: str) -> str:
    return f"{value:+g} {unit}"


def format_duration(milliseconds: int) -> str:
    seconds, _ = divmod(max(milliseconds, 0), 1000)
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {seconds:02d}s"
    if minutes:
        return f"{minutes}m {seconds:02d}s"
    return f"{seconds}s"


def text_cell(text: str) -> Cell:
    return Cell(text)


def number_cell(value: int) -> Cell:
    return Cell(str(value))


def badge_cell(text: str, css: str) -> Cell:
    return Cell(text, css=css, badge=True)


def verdict_cell(verdict: Verdict | None) -> Cell:
    if verdict is None:
        return Cell(NOT_AVAILABLE, css="muted")
    reason = clip(verdict.reason, REASON_MAX_CHARS) if verdict.reason else None
    return Cell(verdict.status.value, css=VERDICT_TONES[verdict.status], badge=True, detail=reason)


def tiles_of(report: RunReport) -> tuple[Tile, ...]:
    stats = report.stats
    counters = report.run.counters
    return (
        Tile("pass^k", format_percent(stats.pass_hat_k), f"{stats.k} attempts per scenario"),
        Tile("Flaky rate", format_percent(stats.flaky_rate)),
        Tile(
            "Scenarios",
            f"{counters.scenarios_done} of {counters.scenarios_total}",
            f"{counters.fail} failing, {counters.uncertain} uncertain",
        ),
        Tile("Open findings", str(stats.open_findings), "of the target, not only this run"),
        Tile("Cost", format_usd(stats.cost_usd.total)),
        Tile(
            "Step latency",
            f"{stats.latency_ms.p50} ms",
            f"p90 {stats.latency_ms.p90} ms, p99 {stats.latency_ms.p99} ms",
        ),
    )


def diff_row(item: RunDiffItem) -> tuple[Cell, ...]:
    return (
        badge_cell(DIFF_CATEGORY_LABELS[item.category], DIFF_CATEGORY_TONES[item.category]),
        text_cell(item.title),
        text_cell(item.family),
        text_cell(f"{item.role} on {item.interface_id}"),
        verdict_cell(item.before),
        verdict_cell(item.after),
    )


def shown_diff_items(diff: RunDiff) -> list[RunDiffItem]:
    return [item for item in diff.items if item.category in SHOWN_DIFF_CATEGORIES]


def diff_note(diff: RunDiff) -> str:
    return (
        f"{len(diff.new_failures)} new failures, {len(diff.fixed)} fixed, "
        f"{len(diff.still_failing)} still failing, {len(diff.flaky_changes)} with changed "
        f"flakiness. Cost {format_signed(diff.cost_delta_usd, 'USD')}, median latency "
        f"{format_signed(diff.latency_p50_delta_ms, 'ms')}."
    )


def diff_section(diff: RunDiff | None) -> Section:
    heading = "Changes since the previous run"
    if diff is None:
        return Section(heading, None, "There is no earlier completed run of this plan to compare.")
    shown = shown_diff_items(diff)
    if not shown:
        return Section(heading, None, "No scenario changed its verdict.", diff_note(diff))
    table = Table(
        ("Change", "Scenario", "Family", "Role and interface", "Before", "After"),
        tuple(diff_row(item) for item in shown[:DIFF_ROWS_MAX]),
        omitted=max(len(shown) - DIFF_ROWS_MAX, 0),
    )
    return Section(heading, table, "", diff_note(diff))


def finding_row(finding: FindingSummary, base_url: str) -> tuple[Cell, ...]:
    return (
        badge_cell(finding.severity.value, f"sev-{finding.severity.value}"),
        text_cell(finding.class_.value),
        text_cell(finding.status.value),
        Cell(finding.title, href=f"{base_url}/findings/{finding.id}"),
        number_cell(finding.occurrence_count),
    )


def finding_section(findings: Sequence[FindingSummary], base_url: str) -> Section:
    heading = "Findings seen in this run"
    if not findings:
        return Section(heading, None, "No finding has an occurrence in this run.")
    ordered = sorted(findings, key=lambda item: SEVERITY_ORDER.index(item.severity))
    table = Table(
        ("Severity", "Class", "Status", "Title", "Occurrences"),
        tuple(finding_row(item, base_url) for item in ordered[:FINDING_ROWS_MAX]),
        omitted=max(len(ordered) - FINDING_ROWS_MAX, 0),
    )
    return Section(heading, table, "")


def family_row(family: FamilyStats) -> tuple[Cell, ...]:
    return (
        text_cell(family.family),
        number_cell(family.scenarios),
        text_cell(format_percent(family.pass_hat_k)),
        number_cell(family.flaky),
        number_cell(family.uncertain),
        number_cell(family.skipped),
    )


def family_section(families: Sequence[FamilyStats]) -> Section:
    heading = "Families"
    if not families:
        return Section(heading, None, "No scenario was planned.")
    table = Table(
        ("Family", "Scenarios", "pass^k", "Flaky", "Uncertain", "Skipped"),
        tuple(family_row(family) for family in families),
    )
    return Section(heading, table, "")


def invariant_row(invariant: InvariantStats) -> tuple[Cell, ...]:
    return (
        text_cell(invariant.invariant_id),
        text_cell(invariant.pack.value),
        number_cell(invariant.pass_),
        number_cell(invariant.fail),
        number_cell(invariant.flaky),
        number_cell(invariant.uncertain),
        number_cell(invariant.skipped),
    )


def invariant_section(invariants: Sequence[InvariantStats]) -> Section:
    heading = "Invariants"
    if not invariants:
        return Section(heading, None, "No invariant was evaluated.")
    table = Table(
        ("Invariant", "Pack", "Pass", "Fail", "Flaky", "Uncertain", "Skipped"),
        tuple(invariant_row(invariant) for invariant in invariants),
    )
    return Section(heading, table, "")


def counters_section(report: RunReport) -> Section:
    counters = report.run.counters
    budget = report.run.budget
    table = Table(
        ("Total", "Done", "Pass", "Fail", "Flaky", "Uncertain", "Skipped", "Steps"),
        (
            (
                number_cell(counters.scenarios_total),
                number_cell(counters.scenarios_done),
                number_cell(counters.pass_),
                number_cell(counters.fail),
                number_cell(counters.flaky),
                number_cell(counters.uncertain),
                number_cell(counters.skipped),
                number_cell(counters.steps_recorded),
            ),
        ),
    )
    note = (
        f"Spent {format_usd(budget.spent_usd)} of {format_usd(budget.max_usd)}; "
        f"ran {format_duration(budget.elapsed_ms)} of {budget.max_minutes} minutes."
    )
    return Section("Scenarios and budget", table, "", note)


def tier_section(report: RunReport) -> Section:
    tiers = report.stats.tiers
    table = Table(
        ("Code", "Laya", "Judge", "Human"),
        (
            (
                number_cell(tiers.code),
                number_cell(tiers.laya),
                number_cell(tiers.judge),
                number_cell(tiers.human),
            ),
        ),
    )
    return Section("Verdicts by grading tier", table, "")


def bundle_description(bundle_version: int | None, bundle_hash: str | None) -> str:
    if bundle_version is None:
        return NOT_AVAILABLE
    return f"version {bundle_version}, hash {bundle_hash}"


def configuration_rows(report: RunReport) -> list[tuple[str, str]]:
    snapshot = report.config_snapshot
    rows = [
        ("Bundle", bundle_description(snapshot.bundle_version, snapshot.bundle_hash)),
        ("Seed hash", snapshot.seed_hash or NOT_AVAILABLE),
        ("Probe bank", snapshot.probe_bank_version or NOT_AVAILABLE),
        ("Scenarios pinned", str(len(snapshot.scenario_versions))),
    ]
    if snapshot.clock is not None:
        rows.append(("Clock", f"{snapshot.clock.mode} at {format_time(snapshot.clock.at)}"))
    if snapshot.base_url_override is not None:
        rows.append(("Base URL override", snapshot.base_url_override))
    for role, model in sorted((snapshot.models or {}).items(), key=lambda item: item[0].value):
        rows.append((f"Model {role.value}", f"{model.model}, effort {model.effort.value}"))
    for name, version in sorted(
        snapshot.prompt_template_versions.items(), key=lambda item: item[0].value
    ):
        rows.append((f"Prompt {name.value}", f"version {version}"))
    return rows


def configuration_section(report: RunReport) -> Section:
    table = Table(
        ("Setting", "Value"),
        tuple((text_cell(name), text_cell(value)) for name, value in configuration_rows(report)),
    )
    return Section("Frozen configuration", table, "")


def subtitle_of(report: RunReport) -> str:
    run = report.run
    parts = [
        f"{run.kind.value} run",
        f"triggered by {run.trigger.value}",
        f"started {format_time(run.started_at)}",
        f"finished {format_time(run.finished_at)}",
        f"lasted {format_duration(run.budget.elapsed_ms)}",
    ]
    if run.read_only:
        parts.append("read-only")
    return ", ".join(parts)


def build_view(report: RunReport, base_url: str) -> ReportView:
    run = report.run
    root = base_url.rstrip("/")
    return ReportView(
        title=f"Tessa report for run {run.id}",
        status=run.status.value,
        status_css=STATUS_TONES.get(run.status, "info"),
        subtitle=subtitle_of(report),
        run_url=f"{root}/runs/{run.id}",
        generated_at=format_time(report.generated_at),
        tiles=tiles_of(report),
        sections=(
            diff_section(report.diff),
            finding_section(report.findings, root),
            family_section(report.stats.families),
            invariant_section(report.stats.invariants),
            counters_section(report),
            tier_section(report),
            configuration_section(report),
        ),
    )


@functools.cache
def report_template() -> Template:
    environment = Environment(
        loader=FileSystemLoader(TEMPLATE_DIRECTORY),
        autoescape=True,
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=True,
    )
    return environment.get_template(TEMPLATE_NAME)


def render_report_html(report: RunReport, base_url: str) -> str:
    return report_template().render(view=build_view(report, base_url))
