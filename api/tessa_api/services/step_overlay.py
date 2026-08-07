from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import LabelRow, RunRow, RunScenarioRow, StepRow
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import (
    LabelSource,
    LabelSubjectType,
    RunScenarioStatus,
    VerdictTier,
)
from tessa_api.schemas.streams import IngestEvent, StepGradedPayload
from tessa_api.services.grading_rules import MachineGrading, human_verdict
from tessa_api.services.run_counters import read_run_counters
from tessa_api.services.run_invariants import attempt_invariant_verdicts
from tessa_api.services.verdict_rollup import (
    aggregate_attempt_verdicts,
    refreshed_attempt_verdict,
)
from tessa_api.services.verdicts import worst_verdict

STEP_GRADED_EVENT = "step.graded"
RUN_PROGRESS_EVENT = "run.progress"


@dataclass(frozen=True, slots=True)
class StepStanding:
    verdict: Verdict | None
    escalated_to: VerdictTier | None


def verdict_of(raw: dict[str, Any] | None) -> Verdict | None:
    return None if raw is None else Verdict.model_validate(raw)


def verdict_json(verdict: Verdict | None) -> dict[str, Any] | None:
    return None if verdict is None else verdict.model_dump(mode="json")


def machine_grading_of(step: StepRow) -> MachineGrading | None:
    if step.machine_grading is None:
        return None
    return MachineGrading.model_validate(step.machine_grading)


def standing_of(machine: MachineGrading | None, human: LabelRow | None) -> StepStanding:
    if human is not None:
        return StepStanding(human_verdict(human.value, human.note), VerdictTier.human)
    if machine is None:
        return StepStanding(None, None)
    return StepStanding(machine.verdict, machine.escalated_to)


async def lock_step(session: AsyncSession, step_id: UUID) -> StepRow | None:
    return await session.scalar(
        select(StepRow)
        .where(StepRow.id == step_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def lock_run_scenario(session: AsyncSession, run_scenario_id: UUID) -> RunScenarioRow | None:
    return await session.scalar(
        select(RunScenarioRow)
        .where(RunScenarioRow.id == run_scenario_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def latest_human_step_label(session: AsyncSession, step_id: UUID) -> LabelRow | None:
    return await session.scalar(
        select(LabelRow)
        .where(
            LabelRow.subject_type == LabelSubjectType.step,
            LabelRow.subject_id == step_id,
            LabelRow.source == LabelSource.human,
        )
        .order_by(LabelRow.labeled_at.desc(), LabelRow.id.desc())
        .limit(1)
    )


def step_graded_event(step: StepRow, standing: StepStanding, token: str) -> IngestEvent | None:
    if standing.verdict is None:
        return None
    payload = StepGradedPayload(
        step_id=step.id,
        run_scenario_id=step.run_scenario_id,
        verdict=standing.verdict,
        escalated_to=standing.escalated_to,
    )
    return IngestEvent(
        run_id=step.run_id,
        type=STEP_GRADED_EVENT,
        payload=payload.model_dump(mode="json"),
        dedupe_key=f"{STEP_GRADED_EVENT}:{step.id}:{token}",
        occurred_at=datetime.now(UTC),
    )


async def attempt_step_verdicts(
    session: AsyncSession, run_scenario_id: UUID, attempt: int
) -> dict[UUID, Verdict | None]:
    rows = await session.execute(
        select(StepRow.id, StepRow.verdict).where(
            StepRow.run_scenario_id == run_scenario_id, StepRow.attempt == attempt
        )
    )
    return {step_id: verdict_of(raw) for step_id, raw in rows}


def present(verdicts: list[Verdict | None]) -> list[Verdict]:
    return [verdict for verdict in verdicts if verdict is not None]


def attempt_entry(run_scenario: RunScenarioRow, attempt: int) -> dict[str, Any] | None:
    return next((entry for entry in run_scenario.attempts if entry["attempt"] == attempt), None)


def scenario_verdict_of(attempts: list[dict[str, Any]]) -> Verdict:
    return aggregate_attempt_verdicts(
        present([verdict_of(entry.get("verdict")) for entry in attempts])
    )


async def refresh_run_counters(
    session: AsyncSession, run_id: UUID, token: str
) -> IngestEvent | None:
    run = await session.scalar(
        select(RunRow)
        .where(RunRow.id == run_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if run is None:
        return None
    await session.flush()
    counters = await read_run_counters(session, run_id)
    payload = counters.model_dump(mode="json", by_alias=True)
    run.counters = payload
    return IngestEvent(
        run_id=run_id,
        type=RUN_PROGRESS_EVENT,
        payload=payload,
        dedupe_key=f"progress:label:{token}",
        occurred_at=datetime.now(UTC),
    )


async def propagate_attempt_change(
    session: AsyncSession,
    step: StepRow,
    previous: Verdict | None,
    token: str,
) -> list[IngestEvent]:
    run_scenario = await lock_run_scenario(session, step.run_scenario_id)
    if run_scenario is None:
        return []
    entry = attempt_entry(run_scenario, step.attempt)
    if entry is None:
        return []
    current = await attempt_step_verdicts(session, run_scenario.id, step.attempt)
    before = present([previous if step_id == step.id else v for step_id, v in current.items()])
    after = present(list(current.values()))
    stored = verdict_of(entry.get("verdict"))
    refreshed = refreshed_attempt_verdict(stored, before, after)
    if refreshed is not None:
        invariant_verdicts = await attempt_invariant_verdicts(
            session, run_scenario.id, step.attempt
        )
        refreshed = worst_verdict([refreshed, *invariant_verdicts]) or refreshed
    if refreshed is None or refreshed == stored:
        return []
    attempts = [
        {**item, "verdict": verdict_json(refreshed)} if item["attempt"] == step.attempt else item
        for item in run_scenario.attempts
    ]
    run_scenario.attempts = attempts
    if run_scenario.status is not RunScenarioStatus.finished:
        return []
    scenario_verdict = verdict_json(scenario_verdict_of(attempts))
    if scenario_verdict == run_scenario.verdict:
        return []
    run_scenario.verdict = scenario_verdict
    progress = await refresh_run_counters(session, run_scenario.run_id, token)
    return [] if progress is None else [progress]


async def refresh_step_verdict(
    session: AsyncSession, step: StepRow, token: str
) -> list[IngestEvent]:
    previous = verdict_of(step.verdict)
    human = await latest_human_step_label(session, step.id)
    standing = standing_of(machine_grading_of(step), human)
    recorded = verdict_json(standing.verdict)
    if recorded == step.verdict:
        return []
    step.verdict = recorded
    await session.flush()
    events: list[IngestEvent] = []
    graded = step_graded_event(step, standing, token)
    if graded is not None:
        events.append(graded)
    events.extend(await propagate_attempt_change(session, step, previous, token))
    return events
