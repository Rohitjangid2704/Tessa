from enum import StrEnum

from temporalio.exceptions import ApplicationError


class FindingsErrorType(StrEnum):
    embedding_input_invalid = "embedding_input_invalid"
    embedding_dimension_mismatch = "embedding_dimension_mismatch"
    embedding_reply_invalid = "embedding_reply_invalid"
    run_not_found = "run_not_found"
    finding_not_found = "finding_not_found"
    repro_unavailable = "repro_unavailable"


def permanent_findings_error(kind: FindingsErrorType, message: str) -> ApplicationError:
    return ApplicationError(message, type=kind.value, non_retryable=True)
