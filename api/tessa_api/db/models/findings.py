import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import ForeignKey, Index, Integer, Text, UniqueConstraint, desc, func
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.common import EMBEDDING_DIMENSIONS
from tessa_api.schemas.enums import ExplanationSource, FindingClass, FindingStatus, Severity

EMPTY_JSON_OBJECT = sql_text("'{}'::jsonb")


class FindingRow(Base):
    __tablename__ = "findings"
    __table_args__ = (
        UniqueConstraint("target_id", "fingerprint"),
        Index(
            "ix_findings_target_id_status_last_seen_at", "target_id", "status", desc("last_seen_at")
        ),
        Index(
            "ix_findings_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    fingerprint: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    class_: Mapped[FindingClass] = mapped_column("class", StrEnumType(FindingClass))
    severity: Mapped[Severity] = mapped_column(StrEnumType(Severity))
    status: Mapped[FindingStatus] = mapped_column(StrEnumType(FindingStatus))
    status_changed_at: Mapped[datetime] = mapped_column(server_default=func.now())
    invariant_id: Mapped[str | None] = mapped_column(Text, default=None)
    scenario_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scenarios.id", ondelete="SET NULL"), default=None
    )
    first_seen_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id"))
    last_seen_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id"))
    first_seen_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(server_default=func.now())
    occurrence_count: Mapped[int] = mapped_column(Integer, server_default=sql_text("1"))
    ticket_url: Mapped[str | None] = mapped_column(Text, default=None)
    known_gap_reason: Mapped[str | None] = mapped_column(Text, default=None)
    promoted_scenario_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scenarios.id", ondelete="SET NULL"), default=None
    )
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(EMBEDDING_DIMENSIONS), default=None
    )
    repro: Mapped[dict[str, Any] | None] = mapped_column(default=None)


class FindingOccurrenceRow(Base):
    __tablename__ = "finding_occurrences"
    __table_args__ = (
        Index("ix_finding_occurrences_finding_id_seen_at", "finding_id", desc("seen_at")),
        UniqueConstraint(
            "finding_id",
            "run_id",
            "run_scenario_id",
            "step_id",
            "attempt",
            name="uq_finding_occurrences_identity",
            postgresql_nulls_not_distinct=True,
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    finding_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("findings.id", ondelete="CASCADE"))
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    run_scenario_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("run_scenarios.id", ondelete="SET NULL"), default=None
    )
    step_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("steps.id", ondelete="SET NULL"), default=None
    )
    attempt: Mapped[int | None] = mapped_column(Integer, default=None)
    seen_at: Mapped[datetime] = mapped_column(server_default=func.now())
    evidence: Mapped[dict[str, Any]] = mapped_column(server_default=EMPTY_JSON_OBJECT)


class ExplanationRow(Base):
    __tablename__ = "explanations"
    __table_args__ = (
        Index("ix_explanations_finding_id_created_at", "finding_id", desc("created_at")),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    finding_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("findings.id", ondelete="CASCADE"))
    text: Mapped[str] = mapped_column(Text)
    source: Mapped[ExplanationSource] = mapped_column(StrEnumType(ExplanationSource))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    structured: Mapped[dict[str, Any] | None] = mapped_column(default=None)
