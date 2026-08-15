from enum import StrEnum

from temporalio.exceptions import ApplicationError


class GradingErrorType(StrEnum):
    step_not_found = "step_not_found"
    run_not_found = "run_not_found"
    budget_exceeded = "budget_exceeded"
    input_too_large = "input_too_large"
    provider_key_missing = "provider_key_missing"
    tiebreak_unavailable = "tiebreak_unavailable"
    provider_rejected = "provider_rejected"
    provider_unavailable = "provider_unavailable"
    stub_model_mismatch = "stub_model_mismatch"
    stub_not_registered = "stub_not_registered"
    role_mismatch = "role_mismatch"
    paired_result_not_found = "paired_result_not_found"
    evidence_invalid = "evidence_invalid"


def permanent_error(kind: GradingErrorType, message: str) -> ApplicationError:
    return ApplicationError(message, type=kind.value, non_retryable=True)


def retryable_error(kind: GradingErrorType, message: str) -> ApplicationError:
    return ApplicationError(message, type=kind.value)
