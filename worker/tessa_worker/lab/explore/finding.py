import uuid
from dataclasses import dataclass

from pydantic import JsonValue

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    FindingClass,
    GoalKind,
    Severity,
    SyntheticFamily,
)
from tessa_api.schemas.model_calls import EMBED_MAX_TEXT_CHARS
from tessa_api.schemas.temporal import AgentGoal, FindingCandidate
from tessa_api.services.findings.classify import Classification, classify_invariant
from tessa_api.services.findings.fingerprint import (
    compute_fingerprint,
    normalize_signal,
    server_error_signal,
)
from tessa_api.services.findings.severity import RoleStanding, severity_for
from tessa_worker.lab.explore.assertions import (
    REACHED,
    REQUEST_FAILED,
    VALUE_SEPARATOR,
)
from tessa_worker.lab.explore.candidates import CandidateView

CHECK_BOUNDARY_REACH = "explore_boundary_reach"
CHECK_CLAIM = "explore_claim"
DETECTOR_CONSOLE = "console_error"
DETECTOR_SERVER_ERROR = "server_error"
DETECTOR_BOUNDARY = "boundary_reach"
TITLE_LIMIT = 200
TITLE_FRAGMENT_CHARS = 90
GOAL_EVIDENCE_CHARS = 300
PATH_EVIDENCE_STEPS = 12
FAMILY = SyntheticFamily.exploration.value


@dataclass(frozen=True, slots=True)
class VerifiedCandidate:
    candidate: CandidateView
    target_id: uuid.UUID
    role: str
    interface_id: str
    scenario_id: uuid.UUID
    run_scenario_id: uuid.UUID
    attempt: int
    step_id: uuid.UUID | None
    final_url: str | None
    replays: int
    goal: AgentGoal | None
    path: tuple[str, ...]


def classification_of(verified: VerifiedCandidate) -> Classification:
    detector = verified.candidate.detector
    if detector == DETECTOR_CONSOLE:
        return classify_invariant(BuiltInInvariantId.no_console_errors.value)
    if detector == DETECTOR_SERVER_ERROR:
        return classify_invariant(BuiltInInvariantId.no_5xx.value)
    if detector == DETECTOR_BOUNDARY:
        return Classification(FindingClass.security_boundary, CHECK_BOUNDARY_REACH, None)
    forbidden = verified.goal is not None and verified.goal.kind is GoalKind.attempt_forbidden
    finding_class = FindingClass.security_boundary if forbidden else FindingClass.wrong_result
    return Classification(finding_class, CHECK_CLAIM, None)


def severity_of(finding_class: FindingClass) -> Severity:
    if finding_class is FindingClass.security_boundary:
        return Severity.high
    return severity_for(finding_class, None, RoleStanding.unknown)


def detail_of(value: str, kind: str) -> str:
    return value.partition(kind + VALUE_SEPARATOR)[2]


def signal_of(verified: VerifiedCandidate) -> str:
    candidate = verified.candidate
    value = candidate.assertion.value
    if candidate.detector == DETECTOR_SERVER_ERROR and value.startswith(REQUEST_FAILED):
        status_text, _, target = detail_of(value, REQUEST_FAILED).partition(VALUE_SEPARATOR)
        if status_text.isdigit():
            return server_error_signal(int(status_text), target)
    if candidate.detector == DETECTOR_CONSOLE:
        return normalize_signal(f"console error {value}")
    if candidate.detector == DETECTOR_BOUNDARY and value.startswith(REACHED):
        return normalize_signal(f"reached {detail_of(value, REACHED)}")
    return normalize_signal(f"{candidate.assertion.check.value} {value}")


def title_of(verified: VerifiedCandidate) -> str:
    candidate = verified.candidate
    value = candidate.assertion.value
    if candidate.detector == DETECTOR_CONSOLE:
        return f"Console error while exploring: {value[:TITLE_FRAGMENT_CHARS]}"
    if candidate.detector == DETECTOR_SERVER_ERROR:
        status, _, target = detail_of(value, REQUEST_FAILED).partition(VALUE_SEPARATOR)
        return f"Server error {status} on {target}"
    if candidate.detector == DETECTOR_BOUNDARY:
        reached = detail_of(value, REACHED)
        return f"{verified.role} reached {reached} while attempting something forbidden"
    return candidate.description


def evidence_of(verified: VerifiedCandidate) -> dict[str, JsonValue]:
    candidate = verified.candidate
    evidence: dict[str, JsonValue] = {
        "source": "exploration",
        "candidate_id": str(candidate.id),
        "candidate_source": candidate.source.value,
        "detector": candidate.detector,
        "assertion_check": candidate.assertion.check.value,
        "assertion_value": candidate.assertion.value,
        "description": candidate.description,
        "replays": verified.replays,
        "path": list(verified.path[-PATH_EVIDENCE_STEPS:]),
        "page_url": verified.final_url,
    }
    if verified.goal is not None:
        evidence["goal_kind"] = verified.goal.kind.value
        evidence["goal"] = verified.goal.statement[:GOAL_EVIDENCE_CHARS]
    return evidence


def build_finding_candidate(verified: VerifiedCandidate) -> FindingCandidate:
    classification = classification_of(verified)
    signal = signal_of(verified)
    title = title_of(verified)[:TITLE_LIMIT]
    candidate = verified.candidate
    fingerprint = compute_fingerprint(
        verified.target_id,
        classification.finding_class,
        classification.check,
        None,
        verified.interface_id,
        verified.role,
        signal,
    )
    return FindingCandidate(
        fingerprint=fingerprint,
        finding_class=classification.finding_class,
        severity=severity_of(classification.finding_class),
        title=title,
        invariant_id=classification.invariant_id,
        scenario_id=verified.scenario_id,
        run_scenario_id=verified.run_scenario_id,
        step_id=verified.step_id,
        attempt=verified.attempt,
        feature_id=None,
        interface_id=verified.interface_id,
        role=verified.role,
        family=FAMILY,
        signal=signal,
        embedding_text=f"{title}\n{signal}"[:EMBED_MAX_TEXT_CHARS],
        evidence=evidence_of(verified),
        expected=f"{candidate.assertion.check.value}: {candidate.assertion.value}",
        actual=f"reproduced {verified.replays} of {verified.replays} times on "
        f"{verified.final_url or 'the page'}",
    )
