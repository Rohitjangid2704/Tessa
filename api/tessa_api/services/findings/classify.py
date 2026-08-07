from collections.abc import Mapping
from dataclasses import dataclass

from tessa_api.schemas.enums import BuiltInInvariantId, FindingClass, Tier0Check

SERVER_ERROR_FLOOR = 500

CHECK_STEP_NOT_COMPLETED = "step_not_completed"
CHECK_ATTEMPT_ERRORED = "attempt_errored"
CHECK_SCENARIO_TIMEOUT = "scenario_timeout"
CHECK_DB_MISMATCH = "db_mismatch"
CHECK_PROBES_FAILED = "probes_failed"
CHECK_JUDGED = "judged"
CHECK_FLAKY = "flaky"
CHECK_SKIPPED_PREFIX = "skipped:"
CHECK_TRIAGE_TRUNCATED = "triage_truncated"

INVARIANT_CLASSES: Mapping[str, FindingClass] = {
    BuiltInInvariantId.no_5xx.value: FindingClass.server_error,
    BuiltInInvariantId.no_console_errors.value: FindingClass.invariant_violation,
    BuiltInInvariantId.auth_boundaries.value: FindingClass.security_boundary,
    BuiltInInvariantId.role_monotonicity.value: FindingClass.security_boundary,
    BuiltInInvariantId.tenant_isolation.value: FindingClass.security_boundary,
    BuiltInInvariantId.pii_by_role.value: FindingClass.security_boundary,
    BuiltInInvariantId.injection_resistance.value: FindingClass.security_boundary,
    BuiltInInvariantId.authority_pressure.value: FindingClass.security_boundary,
    BuiltInInvariantId.refuses_out_of_scope.value: FindingClass.security_boundary,
    BuiltInInvariantId.idempotent_writes.value: FindingClass.invariant_violation,
    BuiltInInvariantId.accessibility.value: FindingClass.accessibility,
    BuiltInInvariantId.latency.value: FindingClass.performance,
    BuiltInInvariantId.no_save_claim_before_confirm.value: FindingClass.safety_claim,
    BuiltInInvariantId.no_internal_ids.value: FindingClass.invariant_violation,
    BuiltInInvariantId.external_facts_labelled.value: FindingClass.invariant_violation,
    BuiltInInvariantId.count_consistency.value: FindingClass.wrong_result,
    BuiltInInvariantId.empty_set_honesty.value: FindingClass.wrong_result,
}
DEFAULT_INVARIANT_CLASS = FindingClass.invariant_violation

TIER0_INVARIANTS: Mapping[Tier0Check, BuiltInInvariantId] = {
    Tier0Check.latency: BuiltInInvariantId.latency,
    Tier0Check.console: BuiltInInvariantId.no_console_errors,
    Tier0Check.internal_ids: BuiltInInvariantId.no_internal_ids,
}


@dataclass(frozen=True, slots=True)
class Classification:
    finding_class: FindingClass
    check: str
    invariant_id: str | None


def class_of_invariant(invariant_id: str) -> FindingClass:
    return INVARIANT_CLASSES.get(invariant_id, DEFAULT_INVARIANT_CLASS)


def classify_invariant(invariant_id: str) -> Classification:
    return Classification(class_of_invariant(invariant_id), invariant_id, invariant_id)


def is_server_error_status(status_code: int | None) -> bool:
    return status_code is not None and status_code >= SERVER_ERROR_FLOOR


def classify_tier0(check: Tier0Check, status_code: int | None) -> Classification:
    if check is Tier0Check.status and is_server_error_status(status_code):
        return classify_invariant(BuiltInInvariantId.no_5xx.value)
    invariant = TIER0_INVARIANTS.get(check)
    if invariant is not None:
        return classify_invariant(invariant.value)
    if check is Tier0Check.schema:
        return Classification(FindingClass.contract, check.value, None)
    return Classification(FindingClass.wrong_result, check.value, None)


def classify_harness(check: str) -> Classification:
    return Classification(FindingClass.harness, check, None)
