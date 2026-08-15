from dataclasses import dataclass

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import VerdictStatus, VerdictTier
from tessa_api.schemas.grading import EvidenceBlock, JudgeEvidence
from tessa_worker.grading.evidence import redact_secrets
from tessa_worker.grading.judge_models import (
    JudgeAnswer,
    JudgeLabel,
    JudgeOutputInvalidError,
    ProviderReply,
    parse_judge_answer,
)
from tessa_worker.grading.stub_markers import STUB_REASON_CODE

REASON_PASS = "judge_pass"
REASON_FAIL = "judge_fail"
REASON_UNCERTAIN = "judge_uncertain"
REASON_OUTPUT_INVALID = "judge_output_invalid"
REASON_ORDER_DISAGREEMENT = "judge_order_disagreement"

LABEL_STATUS = {
    "pass": VerdictStatus.pass_,
    "fail": VerdictStatus.fail,
    "uncertain": VerdictStatus.uncertain,
}
LABEL_REASON: dict[JudgeLabel, str] = {
    "pass": REASON_PASS,
    "fail": REASON_FAIL,
    "uncertain": REASON_UNCERTAIN,
}


@dataclass(frozen=True, slots=True)
class Interpretation:
    verdict: Verdict
    rationale: str
    evidence: JudgeEvidence


def judge_verdict(
    status: VerdictStatus, confidence: float | None, reason_code: str, reason: str
) -> Verdict:
    return Verdict(
        status=status,
        tier=VerdictTier.judge,
        confidence=confidence,
        reason_code=reason_code,
        reason=reason,
        skip_reason=None,
    )


def empty_evidence() -> JudgeEvidence:
    return JudgeEvidence(gold_points=[], must_not_claim=[], unsupported_claims=[])


def invalid_interpretation(reason: str) -> Interpretation:
    message = f"The judge output was unusable: {reason}"
    return Interpretation(
        verdict=judge_verdict(VerdictStatus.uncertain, None, REASON_OUTPUT_INVALID, message),
        rationale=message,
        evidence=empty_evidence(),
    )


def check_against_evidence(answer: JudgeAnswer, evidence: EvidenceBlock) -> None:
    known_keys = {gold.key for gold in evidence.gold_points}
    if any(key not in known_keys for key in answer.gold_points_used):
        raise JudgeOutputInvalidError("a gold point key is not part of the evidence")
    if any(index >= len(evidence.must_not_claim) for index in answer.must_not_claim_found):
        raise JudgeOutputInvalidError("a must-not-claim index is out of range")
    if answer.verdict == "pass" and answer.must_not_claim_found:
        raise JudgeOutputInvalidError("pass contradicts a found must-not-claim item")
    if answer.verdict == "pass" and answer.unsupported_claims:
        raise JudgeOutputInvalidError("pass contradicts the unsupported claims it lists")


def judge_evidence_of(answer: JudgeAnswer, evidence: EvidenceBlock) -> JudgeEvidence:
    used = set(answer.gold_points_used)
    return JudgeEvidence(
        gold_points=[gold for gold in evidence.gold_points if gold.key in used],
        must_not_claim=[evidence.must_not_claim[index] for index in answer.must_not_claim_found],
        unsupported_claims=[redact_secrets(claim) for claim in answer.unsupported_claims],
    )


def interpret_answer(answer: JudgeAnswer, evidence: EvidenceBlock) -> Interpretation:
    check_against_evidence(answer, evidence)
    rationale = redact_secrets(answer.rationale)
    return Interpretation(
        verdict=judge_verdict(
            LABEL_STATUS[answer.verdict], answer.confidence, LABEL_REASON[answer.verdict], rationale
        ),
        rationale=rationale,
        evidence=judge_evidence_of(answer, evidence),
    )


def interpret_reply(reply: ProviderReply, evidence: EvidenceBlock) -> Interpretation:
    if reply.refused:
        return invalid_interpretation("the model refused to answer")
    if reply.incomplete:
        return invalid_interpretation("the answer was cut at the output token limit")
    if reply.text is None:
        return invalid_interpretation("the model returned no text")
    try:
        return interpret_answer(parse_judge_answer(reply.text), evidence)
    except JudgeOutputInvalidError as error:
        return invalid_interpretation(error.reason)


def stamped_as_stub(verdict: Verdict) -> Verdict:
    original = verdict.reason_code
    if original == STUB_REASON_CODE:
        return verdict
    detail = f"[{original}] {verdict.reason}" if original else verdict.reason
    return verdict.model_copy(update={"reason_code": STUB_REASON_CODE, "reason": detail})


def lower_confidence(first: float | None, second: float | None) -> float | None:
    known = [value for value in (first, second) if value is not None]
    return min(known) if known else None


def combine_pair_verdicts(
    first: Verdict, second: Verdict, stub: bool = False
) -> tuple[Verdict, bool]:
    agrees = first.status == second.status
    confidence = lower_confidence(first.confidence, second.confidence)
    if agrees:
        combined = first.model_copy(update={"confidence": confidence})
    else:
        combined = judge_verdict(
            VerdictStatus.uncertain,
            confidence,
            REASON_ORDER_DISAGREEMENT,
            "The verdict changed with the presentation order "
            f"({first.status.value}, then {second.status.value}).",
        )
    return (stamped_as_stub(combined) if stub else combined), agrees
