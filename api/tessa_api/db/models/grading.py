import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Float, ForeignKey, Index, Integer, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.models.runs import MONEY, ZERO
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import (
    Effort,
    InvariantPack,
    JudgeFamily,
    LabelSource,
    LabelSubjectType,
    LabelValue,
    ProbeEngine,
    ProbeStatus,
)


class ProbeResultRow(Base):
    __tablename__ = "probe_results"
    __table_args__ = (
        Index("ix_probe_results_step_id", "step_id"),
        Index("ix_probe_results_run_id_probe_id", "run_id", "probe_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    step_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("steps.id", ondelete="CASCADE"))
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    probe_id: Mapped[str] = mapped_column(Text)
    pack: Mapped[InvariantPack] = mapped_column(StrEnumType(InvariantPack))
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str | None] = mapped_column(Text, default=None)
    status: Mapped[ProbeStatus] = mapped_column(StrEnumType(ProbeStatus))
    confidence: Mapped[float] = mapped_column(Float)
    threshold: Mapped[float] = mapped_column(Float)
    latency_ms: Mapped[int] = mapped_column(Integer)
    probe_bank_version: Mapped[str] = mapped_column(Text)
    engine: Mapped[ProbeEngine] = mapped_column(
        StrEnumType(ProbeEngine), server_default=ProbeEngine.laya.value
    )


class JudgeResultRow(Base):
    __tablename__ = "judge_results"
    __table_args__ = (Index("ix_judge_results_step_id", "step_id"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    step_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("steps.id", ondelete="CASCADE"))
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    family: Mapped[JudgeFamily] = mapped_column(StrEnumType(JudgeFamily))
    model: Mapped[str] = mapped_column(Text)
    effort: Mapped[Effort] = mapped_column(StrEnumType(Effort))
    rubric_version: Mapped[str] = mapped_column(Text)
    verdict: Mapped[dict[str, Any]] = mapped_column()
    pairwise: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    evidence: Mapped[dict[str, Any]] = mapped_column()
    cost_usd: Mapped[Decimal] = mapped_column(MONEY, server_default=ZERO)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class LabelRow(Base):
    __tablename__ = "labels"
    __table_args__ = (
        UniqueConstraint(
            "subject_type",
            "subject_id",
            "source",
            "labeled_by",
            postgresql_nulls_not_distinct=True,
        ),
        Index("ix_labels_subject_type_subject_id", "subject_type", "subject_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    subject_type: Mapped[LabelSubjectType] = mapped_column(StrEnumType(LabelSubjectType))
    subject_id: Mapped[uuid.UUID] = mapped_column()
    value: Mapped[LabelValue] = mapped_column(StrEnumType(LabelValue))
    source: Mapped[LabelSource] = mapped_column(StrEnumType(LabelSource))
    note: Mapped[str | None] = mapped_column(Text, default=None)
    labeled_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), default=None)
    labeled_at: Mapped[datetime] = mapped_column(server_default=func.now())
