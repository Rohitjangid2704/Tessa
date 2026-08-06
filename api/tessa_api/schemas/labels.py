from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Probability, Timestamp
from tessa_api.schemas.enums import LabelReason, LabelSource, LabelSubjectType, LabelValue

LABEL_NOTE_MAX_CHARS = 1000


class LabelCreate(BaseModel):
    subject_type: LabelSubjectType
    subject_id: UUID = Field(
        description="id of the probe result, judge result, invariant result or step"
    )
    value: LabelValue
    note: str | None = Field(default=None, max_length=LABEL_NOTE_MAX_CHARS)


class Label(BaseModel):
    id: UUID
    subject_type: LabelSubjectType
    subject_id: UUID
    value: LabelValue
    source: LabelSource
    note: str | None
    labeled_by: UUID | None = Field(description="reviewer; null for judge_weak labels")
    labeled_at: Timestamp


class LabelPage(BaseModel):
    items: list[Label]
    next_cursor: str | None
    total: int | None


class LabelTask(BaseModel):
    id: str = Field(description="stable key of the task: subject type and subject id")
    subject_type: LabelSubjectType
    subject_id: UUID
    step_id: UUID
    run_id: UUID
    question: str = Field(description="what the reviewer is asked to decide")
    machine_value: LabelValue | None = Field(description="what the machine decided, if anything")
    machine_confidence: Probability | None = Field(description="confidence of the machine value")
    evidence_excerpt: str = Field(description="short redacted excerpt of what was graded")
    reason: LabelReason = Field(description="why the task is in the queue")
    created_at: Timestamp


class LabelTaskPage(BaseModel):
    items: list[LabelTask]
    next_cursor: str | None
    total: int | None


class LabelStats(BaseModel):
    total_human: int = Field(ge=0, description="labels written by people")
    total_weak: int = Field(ge=0, description="labels written from judge verdicts")
    by_subject_type: dict[LabelSubjectType, int] = Field(
        description="human labels per subject type; every type is present"
    )
    agreement_with_machine: Probability | None = Field(
        description="share of human labels that equal the machine value; null without labels"
    )
