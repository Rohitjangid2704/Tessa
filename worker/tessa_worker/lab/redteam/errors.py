from enum import StrEnum

from temporalio.exceptions import ApplicationError


class RedTeamErrorType(StrEnum):
    run_not_found = "redteam_run_not_found"
    target_not_ready = "redteam_target_not_ready"
    family_unknown = "redteam_family_unknown"
    probes_missing = "redteam_probes_missing"
    corpus_invalid = "redteam_corpus_invalid"
    attack_not_found = "redteam_attack_not_found"


def permanent_redteam_error(kind: RedTeamErrorType, message: str) -> ApplicationError:
    return ApplicationError(message, type=kind.value, non_retryable=True)
