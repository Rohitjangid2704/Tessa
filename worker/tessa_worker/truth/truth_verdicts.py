from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import (
    OracleApproval,
    OracleResultStatus,
    SkipReason,
    VerdictStatus,
)
from tessa_api.schemas.oracles import DbCheck
from tessa_worker.verdicts import fail_verdict, pass_verdict, skipped_verdict, uncertain_verdict

ORACLE_NOT_FOUND = "oracle_not_found"
ORACLE_NOT_APPROVED = "oracle_not_approved"
ORACLE_RESULT_MISSING = "oracle_result_missing"
ORACLE_RESULT_PENDING = "oracle_result_pending"
ORACLE_ERROR = "oracle_error"
ORACLE_ROWS_TRUNCATED = "oracle_rows_truncated"
GOLD_PARAMS_INVALID = "oracle_params_invalid"
GOLD_UNAVAILABLE = "gold_unavailable"
DB_MISMATCH = "db_mismatch"
DB_MATCHED = "db_matched"
DB_CHECKS_EMPTY = "db_checks_empty"
DB_CHECK_INCONCLUSIVE = "db_check_inconclusive"


@dataclass(frozen=True, slots=True)
class OracleStanding:
    name: str
    approval: OracleApproval | None
    result_status: OracleResultStatus | None
    error: str | None = None


def oracle_not_found_verdict(name: str) -> Verdict:
    verdict = skipped_verdict(
        SkipReason.precondition_failed,
        f"oracle {name} is not an oracle of the bundle the run uses",
    )
    return verdict.model_copy(update={"reason_code": ORACLE_NOT_FOUND})


def oracle_not_approved_verdict(name: str, approval: OracleApproval) -> Verdict:
    verdict = skipped_verdict(
        SkipReason.precondition_failed,
        f"oracle {name} is {approval.value}; only approved oracles may feed a verdict",
    )
    return verdict.model_copy(update={"reason_code": ORACLE_NOT_APPROVED})


def oracle_gate_verdict(standing: OracleStanding) -> Verdict | None:
    if standing.approval is None:
        return oracle_not_found_verdict(standing.name)
    if standing.approval is not OracleApproval.approved:
        return oracle_not_approved_verdict(standing.name, standing.approval)
    if standing.result_status is None:
        return uncertain_verdict(
            ORACLE_RESULT_MISSING, f"oracle {standing.name} produced no result"
        )
    if standing.result_status is OracleResultStatus.pending:
        return uncertain_verdict(ORACLE_RESULT_PENDING, f"oracle {standing.name} did not finish")
    if standing.result_status is OracleResultStatus.error:
        return uncertain_verdict(
            ORACLE_ERROR, f"oracle {standing.name} failed: {standing.error or 'no detail'}"
        )
    return None


def oracle_truncated_verdict(name: str) -> Verdict:
    return uncertain_verdict(
        ORACLE_ROWS_TRUNCATED,
        f"oracle {name} returned more rows than are kept, so its gold points would be partial",
    )


def gold_unavailable_verdict(reason: str) -> Verdict:
    return uncertain_verdict(GOLD_UNAVAILABLE, reason)


def params_invalid_verdict(name: str, reason: str) -> Verdict:
    return uncertain_verdict(GOLD_PARAMS_INVALID, f"oracle {name}: {reason}")


def gate_check(
    standing: OracleStanding, verdict: Verdict, oracle_result_id: UUID | None = None
) -> DbCheck:
    return DbCheck(
        name=f"oracle:{standing.name}",
        expected=None,
        actual=verdict.reason,
        status=verdict.status,
        oracle_result_id=oracle_result_id,
    )


def db_checks_verdict(standing: OracleStanding, checks: Sequence[DbCheck]) -> Verdict:
    gate = oracle_gate_verdict(standing)
    if gate is not None:
        return gate
    if not checks:
        return uncertain_verdict(DB_CHECKS_EMPTY, "the expectation produced no database check")
    failed = [check for check in checks if check.status is VerdictStatus.fail]
    if failed:
        names = ", ".join(check.name for check in failed)
        return fail_verdict(f"the database does not match: {names}", DB_MISMATCH)
    inconclusive = [check for check in checks if check.status is not VerdictStatus.pass_]
    if inconclusive:
        names = ", ".join(check.name for check in inconclusive)
        return uncertain_verdict(DB_CHECK_INCONCLUSIVE, f"could not settle: {names}")
    verdict = pass_verdict()
    return verdict.model_copy(update={"reason_code": DB_MATCHED})
