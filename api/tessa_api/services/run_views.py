import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import ColumnElement, and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BrowserSessionRow,
    JudgeResultRow,
    ProbeResultRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
    ScenarioVersionRow,
    StepRow,
)
from tessa_api.errors import not_found
from tessa_api.schemas.common import Budget, BudgetState, RunCounters, Verdict, Viewport
from tessa_api.schemas.enums import (
    BrowserSessionStatus,
    RunKind,
    RunScenarioStatus,
    RunStatus,
    VerdictStatus,
)
from tessa_api.schemas.grading import EvidenceBlock, JudgeResult
from tessa_api.schemas.oracles import DbCheck, GoldPoint
from tessa_api.schemas.probes import ProbeResult
from tessa_api.schemas.runs import (
    BrowserSession,
    BrowserSessionList,
    Run,
    RunConfigSnapshot,
    RunScenario,
    RunScenarioAttempt,
    RunScenarioPage,
    RunScenarioSummary,
    RunSummary,
    RunSummaryPage,
)
from tessa_api.schemas.steps import (
    Step,
    StepRequest,
    StepResponse,
    StepSummary,
    StepTool,
    Tier0Result,
)
from tessa_api.services.artifacts import ArtifactSigner, artifact_references
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.settings import Settings

PENDING_ATTEMPT_STATUSES = frozenset({RunScenarioStatus.queued, RunScenarioStatus.running})
TERMINAL_RUN_STATUSES = frozenset(
    {RunStatus.completed, RunStatus.failed, RunStatus.canceled, RunStatus.budget_exceeded}
)

RUN_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(RunRow.created_at, datetime),
}
RUN_ID_COLUMN = sortable(RunRow.id, uuid.UUID)
RUN_SCENARIO_SORT_COLUMNS: dict[str, SortableColumn] = {
    "created_at": sortable(RunScenarioRow.created_at, datetime),
    "status": sortable(RunScenarioRow.status, str),
    "role": sortable(RunScenarioRow.role, str),
    "interface_id": sortable(RunScenarioRow.interface_id, str),
}
RUN_SCENARIO_ID_COLUMN = sortable(RunScenarioRow.id, uuid.UUID)
RUN_SCENARIO_COLUMNS: list[Any] = [RunScenarioRow, ScenarioRow.title, ScenarioRow.family]


@dataclass(frozen=True)
class RunFilters:
    target_id: uuid.UUID | None = None
    statuses: Sequence[RunStatus] = field(default_factory=tuple)
    kinds: Sequence[RunKind] = field(default_factory=tuple)
    plan_id: uuid.UUID | None = None
    created_after: datetime | None = None
    created_before: datetime | None = None


@dataclass(frozen=True)
class RunScenarioFilters:
    statuses: Sequence[RunScenarioStatus] = field(default_factory=tuple)
    verdicts: Sequence[VerdictStatus] = field(default_factory=tuple)
    families: Sequence[str] = field(default_factory=tuple)
    roles: Sequence[str] = field(default_factory=tuple)


def elapsed_milliseconds(row: RunRow, now: datetime) -> int:
    if row.started_at is None:
        return 0
    end = row.finished_at or now
    return max(round((end - row.started_at).total_seconds() * 1000), 0)


def to_budget_state(row: RunRow, now: datetime) -> BudgetState:
    budget = Budget.model_validate(row.budget)
    return BudgetState(
        max_usd=budget.max_usd,
        spent_usd=float(row.spent_usd),
        max_minutes=budget.max_minutes,
        elapsed_ms=elapsed_milliseconds(row, now),
    )


def to_run_summary(row: RunRow, now: datetime) -> RunSummary:
    return RunSummary(
        id=row.id,
        kind=row.kind,
        target_id=row.target_id,
        plan_id=row.plan_id,
        status=row.status,
        counters=RunCounters.model_validate(row.counters),
        budget=to_budget_state(row, now),
        read_only=row.read_only,
        started_at=row.started_at,
        finished_at=row.finished_at,
        created_at=row.created_at,
    )


def temporal_ui_link(settings: Settings, workflow_id: str) -> str:
    base = f"{settings.temporal_ui_url}/namespaces/{settings.temporal_namespace}"
    return f"{base}/workflows/{workflow_id}"


def to_run_with_link(row: RunRow, now: datetime, temporal_ui_url: str | None) -> Run:
    return Run(
        **to_run_summary(row, now).model_dump(),
        trigger=row.trigger,
        bundle_id=row.bundle_id,
        config_snapshot=RunConfigSnapshot.model_validate(row.config_snapshot),
        event_head_seq=row.event_head_seq,
        workflow_id=row.workflow_id,
        temporal_ui_url=temporal_ui_url,
        stop_requested_at=row.stop_requested_at,
        created_by=row.created_by,
    )


def to_run(row: RunRow, settings: Settings, now: datetime) -> Run:
    return to_run_with_link(row, now, temporal_ui_link(settings, row.workflow_id))


async def get_run_row(session: AsyncSession, run_id: uuid.UUID) -> RunRow:
    row = await session.get(RunRow, run_id)
    if row is None:
        raise not_found("Run not found")
    return row


async def read_run(session: AsyncSession, settings: Settings, run_id: uuid.UUID) -> Run:
    return to_run(await get_run_row(session, run_id), settings, datetime.now(UTC))


def run_conditions(filters: RunFilters) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if filters.target_id is not None:
        conditions.append(RunRow.target_id == filters.target_id)
    if filters.statuses:
        conditions.append(RunRow.status.in_(list(filters.statuses)))
    if filters.kinds:
        conditions.append(RunRow.kind.in_(list(filters.kinds)))
    if filters.plan_id is not None:
        conditions.append(RunRow.plan_id == filters.plan_id)
    if filters.created_after is not None:
        conditions.append(RunRow.created_at >= filters.created_after)
    if filters.created_before is not None:
        conditions.append(RunRow.created_at <= filters.created_before)
    return conditions


async def list_runs(session: AsyncSession, query: PageQuery, filters: RunFilters) -> RunSummaryPage:
    statement = select(RunRow)
    conditions = run_conditions(filters)
    if conditions:
        statement = statement.where(and_(*conditions))
    page = await paginate(session, statement, RUN_SORT_COLUMNS, RUN_ID_COLUMN, query)
    now = datetime.now(UTC)
    return RunSummaryPage(
        items=[to_run_summary(row[0], now) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


def verdict_of(raw: dict[str, Any] | None) -> Verdict | None:
    return Verdict.model_validate(raw) if raw is not None else None


def attempts_done(attempts: Sequence[dict[str, Any]]) -> int:
    return sum(
        1
        for attempt in attempts
        if RunScenarioStatus(attempt["status"]) not in PENDING_ATTEMPT_STATUSES
    )


def duration_milliseconds(row: RunScenarioRow) -> int | None:
    if row.started_at is None or row.finished_at is None:
        return None
    return max(round((row.finished_at - row.started_at).total_seconds() * 1000), 0)


def to_run_scenario_summary(row: RunScenarioRow, title: str, family: str) -> RunScenarioSummary:
    return RunScenarioSummary(
        id=row.id,
        scenario_id=row.scenario_id,
        title=title,
        family=family,
        role=row.role,
        interface_id=row.interface_id,
        status=row.status,
        verdict=verdict_of(row.verdict),
        attempts_total=row.attempts_total,
        attempts_done=attempts_done(row.attempts),
        duration_ms=duration_milliseconds(row),
    )


def run_scenario_conditions(
    run_id: uuid.UUID, filters: RunScenarioFilters
) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = [RunScenarioRow.run_id == run_id]
    if filters.statuses:
        conditions.append(RunScenarioRow.status.in_(list(filters.statuses)))
    if filters.verdicts:
        conditions.append(
            RunScenarioRow.verdict["status"].astext.in_(
                [verdict.value for verdict in filters.verdicts]
            )
        )
    if filters.families:
        conditions.append(ScenarioRow.family.in_(list(filters.families)))
    if filters.roles:
        conditions.append(RunScenarioRow.role.in_(list(filters.roles)))
    return conditions


async def list_run_scenarios(
    session: AsyncSession, run_id: uuid.UUID, query: PageQuery, filters: RunScenarioFilters
) -> RunScenarioPage:
    await get_run_row(session, run_id)
    statement = (
        select(*RUN_SCENARIO_COLUMNS)
        .join(ScenarioRow, ScenarioRow.id == RunScenarioRow.scenario_id)
        .where(and_(*run_scenario_conditions(run_id, filters)))
    )
    page = await paginate(
        session, statement, RUN_SCENARIO_SORT_COLUMNS, RUN_SCENARIO_ID_COLUMN, query
    )
    return RunScenarioPage(
        items=[to_run_scenario_summary(row[0], row[1], row[2]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def list_browser_sessions(
    session: AsyncSession, run_id: uuid.UUID, statuses: Sequence[BrowserSessionStatus]
) -> BrowserSessionList:
    await get_run_row(session, run_id)
    statement = (
        select(BrowserSessionRow, ScenarioRow.title)
        .join(RunScenarioRow, RunScenarioRow.id == BrowserSessionRow.run_scenario_id)
        .join(ScenarioRow, ScenarioRow.id == RunScenarioRow.scenario_id)
        .where(BrowserSessionRow.run_id == run_id)
        .order_by(BrowserSessionRow.started_at, BrowserSessionRow.id)
    )
    if statuses:
        statement = statement.where(BrowserSessionRow.status.in_(list(statuses)))
    rows = (await session.execute(statement)).all()
    return BrowserSessionList(
        items=[
            BrowserSession(
                id=row.id,
                run_scenario_id=row.run_scenario_id,
                scenario_title=title,
                attempt=row.attempt,
                status=row.status,
                viewport=Viewport.model_validate(row.viewport),
                last_url=row.last_url,
                has_recording=row.recording is not None,
                has_trace=row.trace is not None,
                started_at=row.started_at,
                ended_at=row.ended_at,
            )
            for row, title in rows
        ]
    )


def to_step_summary(row: StepRow) -> StepSummary:
    return StepSummary(
        id=row.id,
        index=row.index,
        attempt=row.attempt,
        adapter=row.adapter,
        label=row.label,
        ok=row.ok,
        latency_ms=row.latency_ms,
        cost_usd=float(row.cost_usd),
        tier0_failure_count=row.tier0_failure_count,
        screenshot_count=row.screenshot_count,
        verdict=verdict_of(row.verdict),
    )


async def read_run_scenario(session: AsyncSession, run_scenario_id: uuid.UUID) -> RunScenario:
    found = (
        await session.execute(
            select(RunScenarioRow, ScenarioRow.title, ScenarioRow.family, ScenarioRow.yaml)
            .join(ScenarioRow, ScenarioRow.id == RunScenarioRow.scenario_id)
            .where(RunScenarioRow.id == run_scenario_id)
        )
    ).first()
    if found is None:
        raise not_found("Scenario execution not found")
    row, title, family, current_yaml = found
    pinned = await session.get(ScenarioVersionRow, (row.scenario_id, row.scenario_version))
    scenario_yaml = pinned.yaml if pinned is not None else current_yaml
    steps = (
        await session.scalars(
            select(StepRow)
            .where(StepRow.run_scenario_id == run_scenario_id)
            .order_by(StepRow.attempt, StepRow.index)
        )
    ).all()
    summary = to_run_scenario_summary(row, title, family)
    return RunScenario(
        **summary.model_dump(),
        attempts=[RunScenarioAttempt.model_validate(attempt) for attempt in row.attempts],
        steps=[to_step_summary(step) for step in steps],
        scenario_yaml=scenario_yaml,
        skip_reason=row.skip_reason,
    )


def to_step(
    row: StepRow,
    signer: ArtifactSigner,
    probes: Sequence[ProbeResultRow],
    judge: JudgeResultRow | None,
    now: datetime,
) -> Step:
    return Step(
        id=row.id,
        run_id=row.run_id,
        run_scenario_id=row.run_scenario_id,
        attempt=row.attempt,
        index=row.index,
        adapter=row.adapter,
        label=row.label,
        request=StepRequest.model_validate(row.request) if row.request is not None else None,
        response=StepResponse.model_validate(row.response) if row.response is not None else None,
        response_truncated=row.response_truncated,
        payload_purged=row.payload_purged_at is not None,
        ask=row.ask,
        answer=row.answer,
        tools=[StepTool.model_validate(tool) for tool in row.tools],
        cards=row.cards,
        latency_ms=row.latency_ms,
        cost_usd=float(row.cost_usd),
        tier0=Tier0Result.model_validate(row.tier0),
        artifacts=artifact_references(signer, row.artifacts, now),
        verdict=verdict_of(row.verdict),
        gold_points=[GoldPoint.model_validate(point) for point in row.gold_points],
        db_checks=[DbCheck.model_validate(check) for check in row.db_checks],
        probes=[ProbeResult.model_validate(probe, from_attributes=True) for probe in probes],
        judge=JudgeResult.model_validate(judge, from_attributes=True)
        if judge is not None
        else None,
        evidence=EvidenceBlock.model_validate(row.evidence) if row.evidence is not None else None,
        started_at=row.started_at,
        finished_at=row.finished_at,
    )


async def read_step(session: AsyncSession, signer: ArtifactSigner, step_id: uuid.UUID) -> Step:
    row = await session.get(StepRow, step_id)
    if row is None:
        raise not_found("Step not found")
    probes = (
        await session.scalars(
            select(ProbeResultRow)
            .where(ProbeResultRow.step_id == step_id)
            .order_by(ProbeResultRow.probe_id, ProbeResultRow.id)
        )
    ).all()
    judge = await session.scalar(
        select(JudgeResultRow)
        .where(JudgeResultRow.step_id == step_id)
        .order_by(JudgeResultRow.created_at.desc(), JudgeResultRow.id.desc())
        .limit(1)
    )
    return to_step(row, signer, probes, judge, datetime.now(UTC))
