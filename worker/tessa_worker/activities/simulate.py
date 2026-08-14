from collections.abc import Mapping

from temporalio import activity

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.temporal import (
    CHECK_SIMULATION_ACTIVITY,
    SEND_TARGET_TURN_ACTIVITY,
    CheckSimulationInput,
    CheckSimulationResult,
    SendTargetTurnInput,
    SendTargetTurnResult,
)
from tessa_worker.activities.drive import heartbeating
from tessa_worker.activities.drive_ports import AdapterOpener
from tessa_worker.activities.judge import JudgeActivities
from tessa_worker.checks.tier0 import evaluate_tier0
from tessa_worker.event_client import EventClient
from tessa_worker.lab.simulate.checker import (
    CheckerDependencies,
    EvaluateInvariants,
    SimulationChecker,
)
from tessa_worker.lab.simulate.sender import TargetTurnSender
from tessa_worker.settings import WorkerSettings
from tessa_worker.truth.step_checks import StepChecks

SEND_HEARTBEAT_SECONDS = 2.0


def no_progress_details() -> Mapping[str, int]:
    return {}


class SimulationActivities:
    def __init__(self, sender: TargetTurnSender, checker: SimulationChecker) -> None:
        self.sender = sender
        self.checker = checker

    @activity.defn(name=SEND_TARGET_TURN_ACTIVITY)
    async def send_target_turn(self, request: SendTargetTurnInput) -> SendTargetTurnResult:
        async with heartbeating(SEND_HEARTBEAT_SECONDS, no_progress_details):
            return await self.sender.send(request)

    @activity.defn(name=CHECK_SIMULATION_ACTIVITY)
    async def check_simulation(self, request: CheckSimulationInput) -> CheckSimulationResult:
        return await self.checker.check(request)


def default_simulation_activities(
    settings: WorkerSettings,
    session_factory: SessionFactory,
    events: EventClient,
    adapters: AdapterOpener,
    checks: StepChecks,
    evaluate_invariants: EvaluateInvariants,
    judge: JudgeActivities,
) -> SimulationActivities:
    return SimulationActivities(
        TargetTurnSender(settings, session_factory, events, adapters, evaluate_tier0),
        SimulationChecker(
            CheckerDependencies(
                settings=settings,
                session_factory=session_factory,
                events=events,
                checks=checks,
                evaluate_invariants=evaluate_invariants,
                judge_runner=judge.runner,
            )
        ),
    )
