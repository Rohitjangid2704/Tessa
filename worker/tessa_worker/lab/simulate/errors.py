from enum import StrEnum

from temporalio.exceptions import ApplicationError


class SimulatorErrorType(StrEnum):
    session_not_found = "sim_session_not_found"
    scenario_not_found = "simulation_scenario_not_found"
    no_chat_interface = "no_chat_interface"
    target_unreachable = "target_unreachable"
    target_turn_failed = "target_turn_failed"


def permanent_simulator_error(kind: SimulatorErrorType, message: str) -> ApplicationError:
    return ApplicationError(message, type=kind.value, non_retryable=True)
