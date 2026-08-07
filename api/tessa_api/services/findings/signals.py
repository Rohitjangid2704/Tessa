import json
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from pydantic import JsonValue

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import FindingClass, Tier0Check, VerdictStatus
from tessa_api.schemas.oracles import DbCheck
from tessa_api.schemas.steps import Tier0Failure
from tessa_api.services.findings.classify import (
    CHECK_ATTEMPT_ERRORED,
    CHECK_DB_MISMATCH,
    CHECK_JUDGED,
    CHECK_PROBES_FAILED,
    CHECK_SCENARIO_TIMEOUT,
    CHECK_STEP_NOT_COMPLETED,
    Classification,
    classify_harness,
    classify_invariant,
    classify_tier0,
    is_server_error_status,
)
from tessa_api.services.findings.fingerprint import (
    normalize_signal,
    request_target,
    server_error_signal,
)
from tessa_api.services.grading_rules import clip_text, redacted_text
from tessa_api.services.probe_specs import ProbeSpec

SUMMARY_LIMIT = 160
VALUE_LIMIT = 300
TIER0_FAILED_CODE = "tier0_failed"
STEP_NOT_COMPLETED_CODE = "step_not_completed"
DB_MISMATCH_CODE = "db_mismatch"
PROBES_FAILED_CODE = "probes_failed"
SCENARIO_TIMEOUT_CODE = "scenario_timeout"
COVERED_BY_TIER0_CODES = frozenset({TIER0_FAILED_CODE, STEP_NOT_COMPLETED_CODE})
MAX_DB_CHECK_NAMES = 5


@dataclass(frozen=True, slots=True)
class StepView:
    id: UUID
    run_scenario_id: UUID
    attempt: int
    index: int
    label: str
    method: str | None
    address: str | None
    status_code: int | None
    ok: bool | None
    ask: str | None
    answer: str | None
    tier0_failures: tuple[Tier0Failure, ...]
    verdict: Verdict | None
    db_checks: tuple[DbCheck, ...]
    operation: str | None = None


@dataclass(frozen=True, slots=True)
class Signal:
    classification: Classification
    signal: str
    summary: str
    expected: JsonValue
    actual: JsonValue
    reason_code: str | None = None

    @property
    def finding_class(self) -> FindingClass:
        return self.classification.finding_class


def safe_text(text: str, limit: int = SUMMARY_LIMIT) -> str:
    return clip_text(redacted_text(" ".join(text.split())), limit)


def compact_value(value: JsonValue, limit: int = VALUE_LIMIT) -> JsonValue:
    if value is None or isinstance(value, bool | int | float):
        return value
    text = (
        value
        if isinstance(value, str)
        else json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    )
    return clip_text(redacted_text(text), limit)


def status_code_of(failure: Tier0Failure) -> int | None:
    actual = failure.actual
    if (
        failure.check is Tier0Check.status
        and isinstance(actual, int)
        and not isinstance(actual, bool)
    ):
        return actual
    return None


def step_target(step: StepView) -> str:
    return step.operation or request_target(step.method, step.address)


def server_error_of(step: StepView, status_code: int, classification: Classification) -> Signal:
    target = step_target(step)
    return Signal(
        classification=classification,
        signal=server_error_signal(status_code, target),
        summary=f"HTTP {status_code} from {target}",
        expected=None,
        actual=status_code,
    )


def not_completed_signal(failure: Tier0Failure) -> Signal:
    detail = failure.actual if isinstance(failure.actual, str) else failure.message
    return Signal(
        classification=classify_harness(CHECK_STEP_NOT_COMPLETED),
        signal=normalize_signal(detail),
        summary=safe_text(f"A step did not complete: {detail}"),
        expected=compact_value(failure.expected),
        actual=compact_value(failure.actual),
        reason_code=STEP_NOT_COMPLETED_CODE,
    )


def tier0_signal(step: StepView, failure: Tier0Failure) -> Signal:
    if step.ok is False and failure.check is Tier0Check.status:
        return not_completed_signal(failure)
    status_code = status_code_of(failure)
    classification = classify_tier0(failure.check, status_code)
    if status_code is not None and is_server_error_status(status_code):
        return server_error_of(step, status_code, classification)
    return Signal(
        classification=classification,
        signal=normalize_signal(f"{failure.check.value}: {failure.message}"),
        summary=safe_text(failure.message),
        expected=compact_value(failure.expected),
        actual=compact_value(failure.actual),
        reason_code=TIER0_FAILED_CODE,
    )


def tier0_signals(step: StepView) -> list[Signal]:
    return [tier0_signal(step, failure) for failure in step.tier0_failures]


def invariant_signal(invariant_id: str, message: str, step: StepView | None, flaky: bool) -> Signal:
    classification = classify_invariant(invariant_id)
    if flaky:
        classification = Classification(FindingClass.flaky, invariant_id, invariant_id)
    status_code = None if step is None else step.status_code
    if (
        step is not None
        and status_code is not None
        and not flaky
        and classification.finding_class is FindingClass.server_error
        and is_server_error_status(status_code)
    ):
        return server_error_of(step, status_code, classification)
    detail = message.strip() or invariant_id
    return Signal(
        classification=classification,
        signal=normalize_signal(f"{invariant_id}: {detail}"),
        summary=safe_text(f"Invariant {invariant_id}: {detail}"),
        expected=f"invariant {invariant_id} holds",
        actual=safe_text(detail, VALUE_LIMIT),
    )


def failed_db_checks(step: StepView) -> list[DbCheck]:
    return [check for check in step.db_checks if check.status is VerdictStatus.fail]


def db_mismatch_signal(step: StepView) -> Signal:
    failed = failed_db_checks(step)
    names = ", ".join(sorted(check.name for check in failed)[:MAX_DB_CHECK_NAMES])
    first = failed[0] if failed else None
    return Signal(
        classification=Classification(FindingClass.wrong_result, CHECK_DB_MISMATCH, None),
        signal=normalize_signal(f"database check mismatch: {names or 'unnamed'}"),
        summary=safe_text(
            f"Database state differs from what the step should have produced: {names}"
        ),
        expected=None if first is None else compact_value(first.expected),
        actual=None if first is None else compact_value(first.actual),
        reason_code=DB_MISMATCH_CODE,
    )


def probe_signals(step: StepView, violated: Sequence[ProbeSpec]) -> list[Signal]:
    if not violated:
        return [
            Signal(
                classification=Classification(FindingClass.wrong_result, CHECK_PROBES_FAILED, None),
                signal=normalize_signal("a probe judged the answer non-compliant"),
                summary="A probe judged the answer non-compliant",
                expected=None,
                actual=None if step.answer is None else compact_value(step.answer),
                reason_code=PROBES_FAILED_CODE,
            )
        ]
    by_invariant: dict[str, ProbeSpec] = {}
    for spec in violated:
        by_invariant.setdefault(spec.invariant_id, spec)
    return [
        Signal(
            classification=classify_invariant(invariant_id),
            signal=normalize_signal(f"{invariant_id}: probe {spec.id} not compliant"),
            summary=safe_text(f"Invariant {invariant_id}: {spec.question}"),
            expected=f"invariant {invariant_id} holds",
            actual=None if step.answer is None else compact_value(step.answer),
            reason_code=PROBES_FAILED_CODE,
        )
        for invariant_id, spec in sorted(by_invariant.items())
    ]


def judged_signal(verdict: Verdict) -> Signal:
    code = verdict.reason_code or CHECK_JUDGED
    detail = verdict.reason or code
    return Signal(
        classification=Classification(FindingClass.wrong_result, CHECK_JUDGED, None),
        signal=normalize_signal(f"{verdict.tier.value} verdict: {code}"),
        summary=safe_text(f"Judged incorrect: {detail}"),
        expected=None,
        actual=safe_text(detail, VALUE_LIMIT),
        reason_code=code,
    )


def verdict_signals(step: StepView, violated_probes: Sequence[ProbeSpec]) -> list[Signal]:
    verdict = step.verdict
    if verdict is None or verdict.status is not VerdictStatus.fail:
        return []
    code = verdict.reason_code or ""
    if code in COVERED_BY_TIER0_CODES:
        return []
    if code == DB_MISMATCH_CODE:
        return [db_mismatch_signal(step)]
    if code == PROBES_FAILED_CODE:
        return probe_signals(step, violated_probes)
    return [judged_signal(verdict)]


def attempt_timeout_signal(reason: str | None) -> Signal:
    return Signal(
        classification=Classification(FindingClass.performance, CHECK_SCENARIO_TIMEOUT, None),
        signal=normalize_signal("the scenario exceeded its timeout"),
        summary="The scenario exceeded its timeout",
        expected="the scenario finishes within its timeout",
        actual=None if reason is None else safe_text(reason, VALUE_LIMIT),
        reason_code=SCENARIO_TIMEOUT_CODE,
    )


def attempt_error_signal(reason_code: str, reason: str | None) -> Signal:
    detail = reason or reason_code
    return Signal(
        classification=classify_harness(CHECK_ATTEMPT_ERRORED),
        signal=normalize_signal(detail),
        summary=safe_text(f"The harness could not run the scenario: {detail}"),
        expected="the scenario runs to its end",
        actual=safe_text(detail, VALUE_LIMIT),
        reason_code=reason_code,
    )
