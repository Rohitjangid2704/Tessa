from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import LabelReason, ProbeStatus, VerdictStatus, VerdictTier
from tessa_api.schemas.grading import GradePolicy
from tessa_api.schemas.probes import ProbeResult
from tessa_api.schemas.steps import Tier0Result
from tessa_worker.verdicts import STEP_NOT_COMPLETED, TIER0_FAILED, TIER0_PASSED, clip_reason

PROBES_PASSED = "probes_passed"
PROBES_FAILED = "probes_failed"
JUDGE_VERDICT = "judge_verdict"
JUDGE_TIEBREAK = "judge_tiebreak"
JUDGE_UNCERTAIN = "judge_uncertain"
JUDGE_INVALID_VERDICT = "judge_invalid_verdict"
JUDGE_ORDER_DISAGREEMENT = "judge_order_disagreement"
JUDGE_UNAVAILABLE = "judge_unavailable"
JUDGE_DISABLED = "judge_disabled"
JUDGE_DISABLED_REASON = "the run grades with code and Laya only, so no judge model was called"
TIEBREAK_DISABLED = "tiebreak_disabled"
TIEBREAK_UNAVAILABLE = "tiebreak_unavailable"
TIEBREAK_UNCERTAIN = "tiebreak_uncertain"
BUDGET_EXHAUSTED = "budget_exhausted"
GRADING_UNAVAILABLE = "grading_unavailable"
TIER0_UNAVAILABLE = "tier0_unavailable"

JUDGED_STATUSES = frozenset({VerdictStatus.pass_, VerdictStatus.fail})
KNOWN_JUDGE_STATUSES = JUDGED_STATUSES | {VerdictStatus.uncertain}
MAX_DESCRIBED_PROBES = 3
FULL_CONFIDENCE = 1.0


class JudgeStage(StrEnum):
    judge = "judge"
    swapped = "swapped"
    tiebreak = "tiebreak"


@dataclass(frozen=True, slots=True)
class ProbeReading:
    probe_id: str
    status: ProbeStatus
    answer: str | None
    confidence: float
    threshold: float
    compliant_answer: str | None
    allowed_answers: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ProbeStage:
    readings: tuple[ProbeReading, ...] = ()
    failure: str | None = None


@dataclass(frozen=True, slots=True)
class JudgeCall:
    verdict: Verdict
    swapped_agrees: bool | None = None


@dataclass(frozen=True, slots=True)
class JudgeUnavailable:
    reason_code: str
    reason: str


JudgeOutcome = JudgeCall | JudgeUnavailable


@dataclass(frozen=True, slots=True)
class JudgeState:
    reference_exists: bool = False
    first: JudgeOutcome | None = None
    swapped: JudgeOutcome | None = None
    tiebreak: JudgeOutcome | None = None


@dataclass(frozen=True, slots=True)
class Escalate:
    stage: JudgeStage
    reason: str


@dataclass(frozen=True, slots=True)
class Graded:
    verdict: Verdict
    escalated_to: VerdictTier | None
    review_reasons: tuple[LabelReason, ...] = ()


EscalationDecision = Escalate | Graded


@dataclass(frozen=True, slots=True)
class NoProbeEvidence:
    pass


@dataclass(frozen=True, slots=True)
class SettledByProbes:
    status: VerdictStatus
    confidence: float
    reason: str


@dataclass(frozen=True, slots=True)
class NeedsJudge:
    reason: str


ProbeAssessment = NoProbeEvidence | SettledByProbes | NeedsJudge


def probe_reading(
    result: ProbeResult, compliant_answer: str | None, allowed_answers: Sequence[str]
) -> ProbeReading:
    return ProbeReading(
        probe_id=result.probe_id,
        status=result.status,
        answer=result.answer,
        confidence=result.confidence,
        threshold=result.threshold,
        compliant_answer=compliant_answer,
        allowed_answers=tuple(allowed_answers),
    )


def verdict_of(
    status: VerdictStatus,
    tier: VerdictTier,
    confidence: float | None,
    reason_code: str | None,
    reason: str | None,
) -> Verdict:
    return Verdict(
        status=status,
        tier=tier,
        confidence=confidence,
        reason_code=reason_code,
        reason=clip_reason(reason),
        skip_reason=None,
    )


def unresolved(
    reason_code: str,
    reason: str,
    tier: VerdictTier = VerdictTier.code,
    escalated_to: VerdictTier | None = None,
    review_reasons: tuple[LabelReason, ...] = (LabelReason.uncertain,),
) -> Graded:
    return Graded(
        verdict=verdict_of(VerdictStatus.uncertain, tier, None, reason_code, reason),
        escalated_to=escalated_to,
        review_reasons=review_reasons,
    )


def tier0_reason(tier0: Tier0Result) -> str:
    if not tier0.failures:
        return "a tier 0 check failed"
    first = tier0.failures[0]
    text = f"{first.check.value}: {first.message}"
    extra = len(tier0.failures) - 1
    return f"{text} (and {extra} more)" if extra else text


def code_failure(reason_code: str, reason: str) -> Graded:
    return Graded(
        verdict=verdict_of(
            VerdictStatus.fail, VerdictTier.code, FULL_CONFIDENCE, reason_code, reason
        ),
        escalated_to=None,
    )


def is_settled(reading: ProbeReading, policy: GradePolicy) -> bool:
    return (
        reading.status is ProbeStatus.decided
        and reading.answer is not None
        and reading.compliant_answer is not None
        and reading.answer in reading.allowed_answers
        and reading.confidence >= reading.threshold
        and reading.confidence >= policy.judge_escalate_below
    )


def reading_status(reading: ProbeReading) -> VerdictStatus:
    if reading.answer == reading.compliant_answer:
        return VerdictStatus.pass_
    return VerdictStatus.fail


def describe_unsettled(reading: ProbeReading, policy: GradePolicy) -> str:
    if reading.status is ProbeStatus.error:
        return f"probe {reading.probe_id} errored"
    if reading.status is ProbeStatus.uncertain:
        return f"probe {reading.probe_id} was uncertain"
    if reading.compliant_answer is None or reading.answer not in reading.allowed_answers:
        return f"probe {reading.probe_id} gave an answer that cannot be mapped to a verdict"
    floor = max(reading.threshold, policy.judge_escalate_below)
    return f"probe {reading.probe_id} confidence {reading.confidence:.2f} is below {floor:.2f}"


def describe_probe_problems(readings: Sequence[ProbeReading], policy: GradePolicy) -> str:
    shown = [describe_unsettled(reading, policy) for reading in readings[:MAX_DESCRIBED_PROBES]]
    hidden = len(readings) - len(shown)
    text = "; ".join(shown)
    return f"{text}; {hidden} more" if hidden > 0 else text


def settled_statuses(probes: ProbeStage, policy: GradePolicy) -> dict[str, VerdictStatus]:
    return {
        reading.probe_id: reading_status(reading)
        for reading in probes.readings
        if is_settled(reading, policy)
    }


def probe_leaning(probes: ProbeStage, policy: GradePolicy) -> VerdictStatus | None:
    statuses = set(settled_statuses(probes, policy).values())
    return statuses.pop() if len(statuses) == 1 else None


def assess_probes(probes: ProbeStage, policy: GradePolicy) -> ProbeAssessment:
    if probes.failure is not None:
        return NeedsJudge(f"probes could not run: {probes.failure}")
    if not probes.readings:
        return NoProbeEvidence()
    unsettled = [reading for reading in probes.readings if not is_settled(reading, policy)]
    if unsettled:
        return NeedsJudge(describe_probe_problems(unsettled, policy))
    statuses = settled_statuses(probes, policy)
    if len(set(statuses.values())) > 1:
        return NeedsJudge(f"probes disagree: {', '.join(sorted(statuses))}")
    status = next(iter(statuses.values()))
    confidence = min(reading.confidence for reading in probes.readings)
    if status is VerdictStatus.pass_:
        reason = f"{len(statuses)} probe(s) answered compliant"
    else:
        reason = f"probes found a violation: {', '.join(sorted(statuses))}"
    return SettledByProbes(status, confidence, reason)


def judged_status(verdict: Verdict) -> VerdictStatus:
    return verdict.status if verdict.status in JUDGED_STATUSES else VerdictStatus.uncertain


def available_calls(judge: JudgeState) -> list[JudgeCall]:
    outcomes = (judge.first, judge.swapped, judge.tiebreak)
    return [outcome for outcome in outcomes if isinstance(outcome, JudgeCall)]


def orders_disagree(first: JudgeCall, swapped: JudgeCall) -> bool:
    return (
        judged_status(first.verdict) is not judged_status(swapped.verdict)
        or swapped.swapped_agrees is False
    )


def judge_flagged(judge: JudgeState) -> bool:
    if any(
        judged_status(call.verdict) is VerdictStatus.uncertain or call.swapped_agrees is False
        for call in available_calls(judge)
    ):
        return True
    first, swapped = judge.first, judge.swapped
    return (
        isinstance(first, JudgeCall)
        and isinstance(swapped, JudgeCall)
        and orders_disagree(first, swapped)
    )


def review_reasons_for(
    final: VerdictStatus, flagged: bool, leaning: VerdictStatus | None
) -> tuple[LabelReason, ...]:
    reasons: list[LabelReason] = []
    if flagged:
        reasons.append(LabelReason.judge_flagged)
    if final in JUDGED_STATUSES and leaning is not None and leaning is not final:
        reasons.append(LabelReason.disagreement)
    if final is VerdictStatus.uncertain:
        reasons.append(LabelReason.uncertain)
    return tuple(reasons)


def judge_decision(
    verdict: Verdict, judge: JudgeState, probes: ProbeStage, policy: GradePolicy
) -> Graded:
    return Graded(
        verdict=verdict,
        escalated_to=VerdictTier.judge,
        review_reasons=review_reasons_for(
            verdict.status, judge_flagged(judge), probe_leaning(probes, policy)
        ),
    )


def judge_uncertain(
    judge: JudgeState,
    probes: ProbeStage,
    policy: GradePolicy,
    reason_code: str,
    reason: str,
    tier: VerdictTier = VerdictTier.judge,
) -> Graded:
    return judge_decision(
        verdict_of(VerdictStatus.uncertain, tier, None, reason_code, reason), judge, probes, policy
    )


def judged_verdict(
    call: JudgeCall, default_reason_code: str, confidence: float | None, reason_prefix: str = ""
) -> Verdict:
    reason = call.verdict.reason
    return call.verdict.model_copy(
        update={
            "tier": VerdictTier.judge,
            "confidence": confidence,
            "reason_code": call.verdict.reason_code or default_reason_code,
            "reason": clip_reason(f"{reason_prefix}{reason}" if reason else None),
            "skip_reason": None,
        }
    )


def combined_confidence(first: JudgeCall, swapped: JudgeCall) -> float | None:
    values = [
        call.verdict.confidence for call in (first, swapped) if call.verdict.confidence is not None
    ]
    return min(values) if values else None


def uncertain_judge_call(
    call: JudgeCall,
    judge: JudgeState,
    probes: ProbeStage,
    policy: GradePolicy,
    default_reason_code: str,
) -> Graded:
    if call.verdict.status in KNOWN_JUDGE_STATUSES:
        reason_code = call.verdict.reason_code or default_reason_code
    else:
        reason_code = JUDGE_INVALID_VERDICT
    return judge_decision(
        verdict_of(
            VerdictStatus.uncertain,
            VerdictTier.judge,
            None,
            reason_code,
            call.verdict.reason or "the judge could not decide",
        ),
        judge,
        probes,
        policy,
    )


def floor_tier(probes: ProbeStage) -> VerdictTier:
    return VerdictTier.laya if probes.readings else VerdictTier.code


def unavailable_decision(
    outcome: JudgeUnavailable,
    judge: JudgeState,
    probes: ProbeStage,
    policy: GradePolicy,
    tier: VerdictTier,
    prefix: str = "",
) -> Graded:
    return judge_uncertain(
        judge, probes, policy, outcome.reason_code, f"{prefix}{outcome.reason}", tier
    )


def decide_tiebreak(
    judge: JudgeState, probes: ProbeStage, policy: GradePolicy, escalation_reason: str
) -> EscalationDecision:
    tiebreak = judge.tiebreak
    if tiebreak is None:
        if not policy.tiebreak_enabled:
            return judge_uncertain(
                judge,
                probes,
                policy,
                TIEBREAK_DISABLED,
                "the two presentation orders disagreed and the tie-break is disabled",
            )
        return Escalate(JudgeStage.tiebreak, escalation_reason)
    if isinstance(tiebreak, JudgeUnavailable):
        return unavailable_decision(
            tiebreak, judge, probes, policy, VerdictTier.judge, "tie-break not available: "
        )
    if judged_status(tiebreak.verdict) is VerdictStatus.uncertain:
        return uncertain_judge_call(tiebreak, judge, probes, policy, TIEBREAK_UNCERTAIN)
    return judge_decision(
        judged_verdict(tiebreak, JUDGE_TIEBREAK, tiebreak.verdict.confidence, "tie-break: "),
        judge,
        probes,
        policy,
    )


def decide_swapped(
    first: JudgeCall, judge: JudgeState, probes: ProbeStage, policy: GradePolicy
) -> EscalationDecision:
    swapped = judge.swapped
    if swapped is None:
        return Escalate(JudgeStage.swapped, "a reference exists, so the second order is required")
    if isinstance(swapped, JudgeUnavailable):
        return unavailable_decision(
            swapped, judge, probes, policy, VerdictTier.judge, "second order not graded: "
        )
    if not orders_disagree(first, swapped):
        return judge_decision(
            judged_verdict(first, JUDGE_VERDICT, combined_confidence(first, swapped)),
            judge,
            probes,
            policy,
        )
    return decide_tiebreak(judge, probes, policy, "the two presentation orders disagree")


def decide_with_judge(
    judge: JudgeState, probes: ProbeStage, assessment: NeedsJudge, policy: GradePolicy
) -> EscalationDecision:
    first = judge.first
    if first is None:
        return Escalate(JudgeStage.judge, assessment.reason)
    if isinstance(first, JudgeUnavailable):
        return unavailable_decision(
            first, judge, probes, policy, floor_tier(probes), f"{assessment.reason}; judge: "
        )
    if judged_status(first.verdict) is VerdictStatus.uncertain:
        return uncertain_judge_call(first, judge, probes, policy, JUDGE_UNCERTAIN)
    if not judge.reference_exists:
        return judge_decision(
            judged_verdict(first, JUDGE_VERDICT, first.verdict.confidence), judge, probes, policy
        )
    return decide_swapped(first, judge, probes, policy)


def decide_escalation(
    tier0: Tier0Result,
    probes: ProbeStage,
    judge: JudgeState,
    policy: GradePolicy,
    *,
    step_completed: bool = True,
) -> EscalationDecision:
    if not step_completed:
        return code_failure(STEP_NOT_COMPLETED, "the step did not complete")
    if not tier0.passed:
        return code_failure(TIER0_FAILED, tier0_reason(tier0))
    assessment = assess_probes(probes, policy)
    if isinstance(assessment, NoProbeEvidence):
        return Graded(
            verdict=verdict_of(
                VerdictStatus.pass_, VerdictTier.code, FULL_CONFIDENCE, TIER0_PASSED, None
            ),
            escalated_to=None,
        )
    if isinstance(assessment, SettledByProbes):
        reason_code = PROBES_PASSED if assessment.status is VerdictStatus.pass_ else PROBES_FAILED
        return Graded(
            verdict=verdict_of(
                assessment.status,
                VerdictTier.laya,
                assessment.confidence,
                reason_code,
                assessment.reason,
            ),
            escalated_to=VerdictTier.laya,
        )
    return decide_with_judge(judge, probes, assessment, policy)
