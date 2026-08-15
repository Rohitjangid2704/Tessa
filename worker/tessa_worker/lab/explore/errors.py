from enum import StrEnum

from temporalio.exceptions import ApplicationError


class ExploreErrorType(StrEnum):
    run_not_found = "run_not_found"
    session_not_found = "session_not_found"
    session_open_failed = "session_open_failed"
    session_broken = "session_broken"
    candidate_not_found = "candidate_not_found"
    exploration_scenario_missing = "exploration_scenario_missing"
    replay_scenario_invalid = "replay_scenario_invalid"
    browser_unavailable = "browser_unavailable"


def permanent_explore_error(kind: ExploreErrorType, message: str) -> ApplicationError:
    return ApplicationError(message, type=kind.value, non_retryable=True)


def retryable_explore_error(kind: ExploreErrorType, message: str) -> ApplicationError:
    return ApplicationError(message, type=kind.value)
