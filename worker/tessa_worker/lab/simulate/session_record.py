from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import select

from tessa_api.db.models import (
    GoalRow,
    PersonaRow,
    RunRow,
    RunScenarioRow,
    SimSessionRow,
    StepRow,
)
from tessa_api.db.models import Target as TargetRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import AdapterKind, GoalKind
from tessa_api.schemas.sim import SimTurn
from tessa_api.schemas.steps import StepTool
from tessa_worker.lab.simulate.errors import SimulatorErrorType, permanent_simulator_error
from tessa_worker.lab.simulate.transcripts import target_turn_count

EXTERNAL_JUDGES_HINT = "external_judges"
DEFAULT_JUDGEMENT_ADAPTER = AdapterKind.sse


@dataclass(frozen=True, slots=True)
class TurnStep:
    step_id: UUID
    index: int
    adapter: AdapterKind
    ok: bool | None
    error: str | None
    tools: Sequence[StepTool]


@dataclass(frozen=True, slots=True)
class SessionRecord:
    sim_session_id: UUID
    run_id: UUID
    run_scenario_id: UUID
    attempt: int
    target_id: UUID
    persona_name: str
    goal_statement: str
    goal_kind: GoalKind
    criteria: Sequence[str]
    transcript: Sequence[SimTurn]
    turn_steps: Sequence[TurnStep]
    judges_allowed: bool

    @property
    def target_turns(self) -> int:
        return target_turn_count(self.transcript)

    @property
    def judgement_adapter(self) -> AdapterKind:
        return self.turn_steps[0].adapter if self.turn_steps else DEFAULT_JUDGEMENT_ADAPTER


def external_judges_allowed(hints: dict[str, Any]) -> bool:
    return hints.get(EXTERNAL_JUDGES_HINT) is not False


def first_failure_message(tier0: dict[str, Any]) -> str | None:
    failures = tier0.get("failures") or []
    if failures and isinstance(failures[0], dict):
        message = failures[0].get("message")
        return message if isinstance(message, str) else None
    return None


def to_turn_step(row: StepRow) -> TurnStep:
    return TurnStep(
        step_id=row.id,
        index=row.index,
        adapter=row.adapter,
        ok=row.ok,
        error=first_failure_message(row.tier0),
        tools=[StepTool.model_validate(tool) for tool in row.tools],
    )


async def load_session_record(
    session_factory: SessionFactory, sim_session_id: UUID
) -> SessionRecord:
    async with session_factory() as session:
        simulation = await session.get(SimSessionRow, sim_session_id)
        if simulation is None:
            raise permanent_simulator_error(
                SimulatorErrorType.session_not_found,
                f"simulation session {sim_session_id} does not exist",
            )
        run = await session.get(RunRow, simulation.run_id)
        goal = await session.get(GoalRow, simulation.goal_id)
        persona = await session.get(PersonaRow, simulation.persona_id)
        run_scenario = await session.scalar(
            select(RunScenarioRow).where(RunScenarioRow.run_id == simulation.run_id).limit(1)
        )
        target = (
            await session.get(TargetRow, run.target_id)
            if run is not None and run.target_id is not None
            else None
        )
        if run is None or goal is None or persona is None or run_scenario is None or target is None:
            raise permanent_simulator_error(
                SimulatorErrorType.scenario_not_found,
                f"simulation session {sim_session_id} lost its run, goal, persona or scenario",
            )
        transcript = [SimTurn.model_validate(turn) for turn in simulation.transcript]
        steps = (
            await session.scalars(
                select(StepRow)
                .where(
                    StepRow.run_scenario_id == run_scenario.id,
                    StepRow.attempt == simulation.attempt,
                    StepRow.index < target_turn_count(transcript),
                )
                .order_by(StepRow.index)
            )
        ).all()
        return SessionRecord(
            sim_session_id=simulation.id,
            run_id=run.id,
            run_scenario_id=run_scenario.id,
            attempt=simulation.attempt,
            target_id=target.id,
            persona_name=persona.name,
            goal_statement=goal.statement,
            goal_kind=goal.kind,
            criteria=list(goal.success_criteria),
            transcript=transcript,
            turn_steps=[to_turn_step(row) for row in steps],
            judges_allowed=external_judges_allowed(target.hints),
        )
