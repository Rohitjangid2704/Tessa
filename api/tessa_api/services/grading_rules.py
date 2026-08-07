import hashlib
from collections.abc import Mapping
from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import LabelReason, LabelValue, VerdictStatus, VerdictTier
from tessa_api.services.secret_scan import REDACTION, find_matches, merge_spans

HUMAN_REASON_CODE = "human_label"
HUMAN_DEFAULT_REASON = "reviewed by a person"
HUMAN_REASON_LIMIT = 300
HUMAN_CONFIDENCE = 1.0
AUDIT_HASH_HEX_DIGITS = 8
AUDIT_HASH_SPACE = float(16**AUDIT_HASH_HEX_DIGITS)
EXCERPT_ELLIPSIS = "..."

LABEL_VALUE_OF_STATUS: Mapping[VerdictStatus, LabelValue] = {
    VerdictStatus.pass_: LabelValue.pass_,
    VerdictStatus.fail: LabelValue.fail,
    VerdictStatus.uncertain: LabelValue.uncertain,
}
STATUS_OF_LABEL_VALUE: Mapping[LabelValue, VerdictStatus] = {
    value: status for status, value in LABEL_VALUE_OF_STATUS.items()
}


class MachineGrading(BaseModel):
    verdict: Verdict
    escalated_to: VerdictTier | None
    review_reasons: list[LabelReason] = Field(
        description="queue reasons the grading itself produced; audit is decided at read time"
    )


def label_value_of(status: VerdictStatus) -> LabelValue | None:
    return LABEL_VALUE_OF_STATUS.get(status)


def human_verdict(value: LabelValue, note: str | None) -> Verdict:
    status = STATUS_OF_LABEL_VALUE[value]
    reason = (note or "").strip() or HUMAN_DEFAULT_REASON
    return Verdict(
        status=status,
        tier=VerdictTier.human,
        confidence=None if status is VerdictStatus.uncertain else HUMAN_CONFIDENCE,
        reason_code=HUMAN_REASON_CODE,
        reason=clip_text(reason, HUMAN_REASON_LIMIT),
        skip_reason=None,
    )


def clip_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - len(EXCERPT_ELLIPSIS)] + EXCERPT_ELLIPSIS


def redacted_text(text: str) -> str:
    return "\n".join(redacted_line(line) for line in text.split("\n"))


def redacted_line(line: str) -> str:
    spans = merge_spans(find_matches(line))
    if not spans:
        return line
    pieces: list[str] = []
    cursor = 0
    for start, end in spans:
        pieces.append(line[cursor:start])
        pieces.append(REDACTION)
        cursor = end
    pieces.append(line[cursor:])
    return "".join(pieces)


def audit_bucket(step_id: UUID) -> float:
    digest = hashlib.md5(str(step_id).encode(), usedforsecurity=False).hexdigest()
    return int(digest[:AUDIT_HASH_HEX_DIGITS], 16) / AUDIT_HASH_SPACE


def is_audit_sample(step_id: UUID, rate: float) -> bool:
    return audit_bucket(step_id) < rate
