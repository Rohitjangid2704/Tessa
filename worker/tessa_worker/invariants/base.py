from collections.abc import Sequence
from uuid import UUID

from tessa_api.schemas.enums import (
    InvariantCheck,
    InvariantPack,
    SkipReason,
    VerdictStatus,
    VerdictTier,
)
from tessa_worker.invariants.contracts import InvariantOutcome

MESSAGE_LIMIT = 280
FULL_CONFIDENCE = 1.0


def clipped(text: str, limit: int = MESSAGE_LIMIT) -> str:
    collapsed = " ".join(text.split())
    return collapsed if len(collapsed) <= limit else f"{collapsed[: limit - 3]}..."


class EvaluatorBase:
    invariant_id: str
    pack: InvariantPack
    check: InvariantCheck

    def outcome(
        self,
        status: VerdictStatus,
        tier: VerdictTier,
        message: str,
        confidence: float | None = None,
        skip_reason: SkipReason | None = None,
        step_id: UUID | None = None,
        signal: str | None = None,
    ) -> InvariantOutcome:
        return InvariantOutcome(
            invariant_id=self.invariant_id,
            pack=self.pack,
            status=status,
            tier=tier,
            confidence=confidence,
            message=clipped(message),
            skip_reason=skip_reason,
            step_id=step_id,
            signal=None if signal is None else clipped(signal),
        )

    def passed(
        self,
        message: str,
        tier: VerdictTier = VerdictTier.code,
        confidence: float | None = FULL_CONFIDENCE,
        step_id: UUID | None = None,
    ) -> InvariantOutcome:
        return self.outcome(
            VerdictStatus.pass_, tier, message, confidence=confidence, step_id=step_id
        )

    def failed(
        self,
        message: str,
        tier: VerdictTier = VerdictTier.code,
        confidence: float | None = FULL_CONFIDENCE,
        step_id: UUID | None = None,
        signal: str | None = None,
    ) -> InvariantOutcome:
        return self.outcome(
            VerdictStatus.fail,
            tier,
            message,
            confidence=confidence,
            step_id=step_id,
            signal=message if signal is None else signal,
        )

    def uncertain(
        self,
        message: str,
        tier: VerdictTier = VerdictTier.code,
        confidence: float | None = None,
        step_id: UUID | None = None,
    ) -> InvariantOutcome:
        return self.outcome(
            VerdictStatus.uncertain, tier, message, confidence=confidence, step_id=step_id
        )

    def skipped(self, reason: SkipReason, message: str) -> InvariantOutcome:
        return self.outcome(VerdictStatus.skipped, VerdictTier.code, message, skip_reason=reason)

    def checked_or_skipped(
        self, outcomes: Sequence[InvariantOutcome], reason: SkipReason, why: str
    ) -> Sequence[InvariantOutcome]:
        return outcomes if outcomes else [self.skipped(reason, why)]
