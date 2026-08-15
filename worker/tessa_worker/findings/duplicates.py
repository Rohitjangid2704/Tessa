import uuid

from tessa_api.schemas.enums import ProbeStatus
from tessa_api.schemas.temporal import DedupeMatch, FindingCandidate
from tessa_api.services.findings.neighbours import Neighbour
from tessa_api.services.grading_rules import clip_text
from tessa_worker.grading.laya_client import ChoiceRequest, LayaDecision

SAME_PROBLEM = "same problem"
DIFFERENT_PROBLEMS = "different problems"
DUPLICATE_OPTIONS = (SAME_PROBLEM, DIFFERENT_PROBLEMS)
DUPLICATE_QUESTION = "Do the two findings describe the same underlying defect in the application?"
NO_SIGNAL_TEXT = "none"
PAIR_FIELD_LIMIT = 280


def pair_state(candidate: FindingCandidate, neighbour: Neighbour) -> str:
    return "\n".join(
        (
            f"Finding A: {clip_text(candidate.title, PAIR_FIELD_LIMIT)}",
            f"Signal A: {clip_text(candidate.signal, PAIR_FIELD_LIMIT)}",
            f"Finding B: {clip_text(neighbour.title, PAIR_FIELD_LIMIT)}",
            f"Signal B: {clip_text(neighbour.signal or NO_SIGNAL_TEXT, PAIR_FIELD_LIMIT)}",
        )
    )


def duplicate_request(
    question_id: str, candidate: FindingCandidate, neighbour: Neighbour, threshold: float
) -> ChoiceRequest:
    return ChoiceRequest(
        question_id=question_id,
        state=pair_state(candidate, neighbour),
        instructions=DUPLICATE_QUESTION,
        options=DUPLICATE_OPTIONS,
        threshold=threshold,
    )


def new_match(candidate: FindingCandidate) -> DedupeMatch:
    return DedupeMatch(
        fingerprint=candidate.fingerprint,
        kind="new",
        finding_id=None,
        similarity=None,
        possible_duplicate_of=None,
    )


def exact_match(candidate: FindingCandidate, finding_id: uuid.UUID) -> DedupeMatch:
    return DedupeMatch(
        fingerprint=candidate.fingerprint,
        kind="exact",
        finding_id=finding_id,
        similarity=None,
        possible_duplicate_of=None,
    )


def close_pair_match(
    candidate: FindingCandidate, neighbour: Neighbour, decision: LayaDecision
) -> DedupeMatch:
    if decision.status is ProbeStatus.decided and decision.answer == SAME_PROBLEM:
        return DedupeMatch(
            fingerprint=candidate.fingerprint,
            kind="semantic",
            finding_id=neighbour.finding_id,
            similarity=neighbour.similarity,
            possible_duplicate_of=None,
        )
    if decision.status is ProbeStatus.decided:
        return new_match(candidate)
    return DedupeMatch(
        fingerprint=candidate.fingerprint,
        kind="uncertain",
        finding_id=None,
        similarity=neighbour.similarity,
        possible_duplicate_of=neighbour.finding_id,
    )
