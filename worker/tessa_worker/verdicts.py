from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import SkipReason, VerdictStatus, VerdictTier
from tessa_api.services.verdict_rollup import (
    ATTEMPT_ERRORED,
    ATTEMPTS_DISAGREE,
    ATTEMPTS_UNCERTAIN,
    NO_ATTEMPTS,
    REASON_LIMIT,
    SCENARIO_TIMEOUT,
    aggregate_attempt_verdicts,
    clip_reason,
)

TIER0_PASSED = "tier0_passed"
TIER0_FAILED = "tier0_failed"
STEP_NOT_COMPLETED = "step_not_completed"
SCENARIO_WORKFLOW_FAILED = "scenario_workflow_failed"

__all__ = [
    "ATTEMPTS_DISAGREE",
    "ATTEMPTS_UNCERTAIN",
    "ATTEMPT_ERRORED",
    "NO_ATTEMPTS",
    "REASON_LIMIT",
    "SCENARIO_TIMEOUT",
    "SCENARIO_WORKFLOW_FAILED",
    "STEP_NOT_COMPLETED",
    "TIER0_FAILED",
    "TIER0_PASSED",
    "aggregate_attempt_verdicts",
    "clip_reason",
    "fail_verdict",
    "pass_verdict",
    "skipped_verdict",
    "uncertain_verdict",
]


def pass_verdict() -> Verdict:
    return Verdict(
        status=VerdictStatus.pass_,
        tier=VerdictTier.code,
        confidence=1.0,
        reason_code=TIER0_PASSED,
        reason=None,
        skip_reason=None,
    )


def fail_verdict(reason: str | None, reason_code: str = TIER0_FAILED) -> Verdict:
    return Verdict(
        status=VerdictStatus.fail,
        tier=VerdictTier.code,
        confidence=1.0,
        reason_code=reason_code,
        reason=clip_reason(reason),
        skip_reason=None,
    )


def uncertain_verdict(reason_code: str, reason: str | None) -> Verdict:
    return Verdict(
        status=VerdictStatus.uncertain,
        tier=VerdictTier.code,
        confidence=None,
        reason_code=reason_code,
        reason=clip_reason(reason),
        skip_reason=None,
    )


def skipped_verdict(skip_reason: SkipReason, reason: str | None = None) -> Verdict:
    return Verdict(
        status=VerdictStatus.skipped,
        tier=VerdictTier.code,
        confidence=None,
        reason_code=skip_reason.value,
        reason=clip_reason(reason),
        skip_reason=skip_reason,
    )
