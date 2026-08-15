import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import select

from tessa_api.db.models import BundleRow, RunRow, RunScenarioRow, SimSessionRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.bundle import BundleManifest, Interface
from tessa_api.schemas.enums import AdapterKind, SimSpeaker
from tessa_api.schemas.scenario import HttpExpect, ScenarioStep, SseExpect
from tessa_api.schemas.sim import SimTurn
from tessa_api.schemas.temporal import SendTargetTurnInput, SendTargetTurnResult
from tessa_api.services.simulation_scenarios import chat_request_for
from tessa_api.services.smoke_generator import truncated
from tessa_worker.activities.drive_ports import (
    AdapterOpener,
    AdapterOpenError,
    AdapterOpenRequest,
    OpenedAdapter,
)
from tessa_worker.adapters.auth import PLACEHOLDER_PATTERN
from tessa_worker.adapters.base import StepRecord
from tessa_worker.checks.contracts import Tier0Evaluator
from tessa_worker.event_client import EventClient
from tessa_worker.grading.evidence import redact_secrets
from tessa_worker.lab.simulate.errors import SimulatorErrorType, permanent_simulator_error
from tessa_worker.lab.simulate.replies import displayed_reply
from tessa_worker.lab.simulate.steps import persist_turn_step, step_recorded_event
from tessa_worker.lab.simulate.transcripts import append_turn, target_turn_count
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.simulator.sender")

STEP_LABEL_PREVIEW = 60
CLOSE_TIMEOUT_SECONDS = 30.0
DRIVE_TIMEOUT_MARGIN_SECONDS = 10.0
ERROR_TEXT_LIMIT = 300
SCENARIO_STEP: TypeAdapter[ScenarioStep] = TypeAdapter(ScenarioStep)


@dataclass(frozen=True, slots=True)
class TurnScope:
    run_id: UUID
    sim_session_id: UUID
    attempt: int
    target_id: UUID
    bundle_id: UUID
    run_scenario_id: UUID
    role: str
    interface: Interface
    step_index: int


def neutralised(text: str) -> str:
    return PLACEHOLDER_PATTERN.sub(lambda match: f"$ {{{match.group(1)}}}", text)


def step_document(scope: TurnScope, text: str) -> dict[str, object]:
    sse = scope.interface.kind is AdapterKind.sse
    document: dict[str, object] = {
        "adapter": "sse" if sse else "http",
        "label": f"Turn {scope.step_index + 1}: {truncated(text, STEP_LABEL_PREVIEW)}",
        "request": chat_request_for(scope.interface, text),
        "expect": {},
    }
    if sse:
        document["ask"] = text
    return document


def expectations_of(step: ScenarioStep) -> SseExpect | HttpExpect:
    if isinstance(step.expect, SseExpect | HttpExpect):
        return step.expect
    raise TypeError("a chat turn is an http or sse step")


def failure_summary(error: BaseException, redact: Callable[[str], str]) -> str:
    return redact(f"{type(error).__name__}: {error}"[:ERROR_TEXT_LIMIT])


class TargetTurnSender:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        events: EventClient,
        adapters: AdapterOpener,
        tier0: Tier0Evaluator,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events
        self.adapters = adapters
        self.tier0 = tier0

    async def send(self, request: SendTargetTurnInput) -> SendTargetTurnResult:
        scope = await self.load_scope(request)
        opened = await self.open(scope)
        try:
            return await self.converse(scope, opened, neutralised(request.text))
        finally:
            await self.close(opened)

    async def load_scope(self, request: SendTargetTurnInput) -> TurnScope:
        async with self.session_factory() as session:
            simulation = await session.get(SimSessionRow, request.sim_session_id)
            if simulation is None or simulation.run_id != request.run_id:
                raise permanent_simulator_error(
                    SimulatorErrorType.session_not_found,
                    f"simulation session {request.sim_session_id} does not belong to the run",
                )
            run = await session.get(RunRow, request.run_id)
            run_scenario = await session.scalar(
                select(RunScenarioRow).where(RunScenarioRow.run_id == request.run_id).limit(1)
            )
            bundle = (
                await session.get(BundleRow, run.bundle_id)
                if run is not None and run.bundle_id is not None
                else None
            )
        if (
            run is None
            or run.target_id is None
            or run_scenario is None
            or bundle is None
            or bundle.manifest is None
        ):
            raise permanent_simulator_error(
                SimulatorErrorType.scenario_not_found,
                f"run {request.run_id} has no simulation scenario or bundle",
            )
        manifest = BundleManifest.model_validate(bundle.manifest)
        interface = next(
            (item for item in manifest.interfaces if item.id == run_scenario.interface_id), None
        )
        if interface is None:
            raise permanent_simulator_error(
                SimulatorErrorType.no_chat_interface,
                f"the bundle no longer declares interface {run_scenario.interface_id}",
            )
        transcript = [SimTurn.model_validate(turn) for turn in simulation.transcript]
        return TurnScope(
            run_id=run.id,
            sim_session_id=simulation.id,
            attempt=simulation.attempt,
            target_id=run.target_id,
            bundle_id=bundle.id,
            run_scenario_id=run_scenario.id,
            role=run_scenario.role,
            interface=interface,
            step_index=target_turn_count(transcript),
        )

    async def open(self, scope: TurnScope) -> OpenedAdapter:
        try:
            return await self.adapters.open(
                AdapterOpenRequest(
                    target_id=scope.target_id,
                    bundle_id=scope.bundle_id,
                    role=scope.role,
                    interface_id=scope.interface.id,
                    run_id=scope.run_id,
                    run_scenario_id=scope.run_scenario_id,
                    attempt=scope.attempt,
                    read_only=False,
                    step_timeout_seconds=float(self.settings.scenario_timeout_seconds),
                    browser_session_id=new_id(),
                )
            )
        except AdapterOpenError as error:
            raise permanent_simulator_error(
                SimulatorErrorType.target_unreachable,
                f"the target could not be reached as {scope.role}: {error}"[:ERROR_TEXT_LIMIT],
            ) from None

    async def converse(
        self, scope: TurnScope, opened: OpenedAdapter, text: str
    ) -> SendTargetTurnResult:
        asked = opened.redact(redact_secrets(text))
        await append_turn(
            self.session_factory, self.events, scope.sim_session_id, SimSpeaker.persona, asked
        )
        step = SCENARIO_STEP.validate_python(step_document(scope, asked))
        try:
            record = await self.drive(opened, step)
        except Exception as error:
            summary = failure_summary(error, opened.redact)
            logger.warning(
                "simulation_turn_not_driven",
                extra={"run_id": str(scope.run_id), "error_type": type(error).__name__},
            )
            await self.settle_failure(scope, f"(no reply: {summary})")
            raise permanent_simulator_error(
                SimulatorErrorType.target_turn_failed, f"the turn failed: {summary}"
            ) from None
        step_id = await self.record_step(scope, opened, step, record, asked)
        reply = opened.redact(displayed_reply(record))
        if record.ok is False:
            detail = opened.redact(record.error or "the target did not answer")
            await self.settle_failure(scope, f"(no reply: {detail})")
            raise permanent_simulator_error(
                SimulatorErrorType.target_turn_failed, f"the turn did not complete: {detail}"
            )
        await append_turn(
            self.session_factory, self.events, scope.sim_session_id, SimSpeaker.target, reply
        )
        return SendTargetTurnResult(reply_text=reply, step_id=step_id)

    async def drive(self, opened: OpenedAdapter, step: ScenarioStep) -> StepRecord:
        limit = float(self.settings.scenario_timeout_seconds) + DRIVE_TIMEOUT_MARGIN_SECONDS
        async with asyncio.timeout(limit):
            return await opened.adapter.drive(step)

    async def record_step(
        self,
        scope: TurnScope,
        opened: OpenedAdapter,
        step: ScenarioStep,
        record: StepRecord,
        asked: str,
    ) -> UUID:
        described = record if record.ask is not None else record.model_copy(update={"ask": asked})
        tier0 = self.tier0(described, expectations_of(step), opened.tier0_context)
        step_id = await persist_turn_step(
            self.session_factory,
            scope.run_id,
            scope.run_scenario_id,
            scope.attempt,
            scope.step_index,
            described,
            tier0,
        )
        await self.events.deliver(
            [
                step_recorded_event(
                    scope.run_id,
                    scope.run_scenario_id,
                    scope.attempt,
                    scope.step_index,
                    step_id,
                    described,
                    tier0,
                )
            ]
        )
        return step_id

    async def settle_failure(self, scope: TurnScope, text: str) -> None:
        await append_turn(
            self.session_factory, self.events, scope.sim_session_id, SimSpeaker.target, text
        )

    async def close(self, opened: OpenedAdapter) -> None:
        try:
            async with asyncio.timeout(CLOSE_TIMEOUT_SECONDS):
                await opened.adapter.close()
        except Exception as error:
            logger.error(
                "simulation_adapter_close_failed", extra={"error_type": type(error).__name__}
            )
