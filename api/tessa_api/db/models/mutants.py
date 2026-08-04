import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import ForeignKey, Index, Numeric, Text, UniqueConstraint, desc, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.models.runs import EMPTY_JSON_ARRAY
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import MutantStatus, MutationOutcome

POWER = Numeric(8, 6)


class MutantRow(Base):
    __tablename__ = "mutants"
    __table_args__ = (
        UniqueConstraint("target_id", "name"),
        Index("ix_mutants_target_id_created_at", "target_id", desc("created_at")),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    name: Mapped[str] = mapped_column(Text)
    branch: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    expected_catchers: Mapped[list[str]] = mapped_column(JSONB)
    base_url: Mapped[str | None] = mapped_column(Text, default=None)
    deployed_marker: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    status: Mapped[MutantStatus] = mapped_column(StrEnumType(MutantStatus))
    last_outcome: Mapped[MutationOutcome | None] = mapped_column(
        StrEnumType(MutationOutcome), default=None
    )
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class MutationRunRow(Base):
    __tablename__ = "mutation_runs"
    __table_args__ = (
        UniqueConstraint("run_id"),
        Index("ix_mutation_runs_mutant_id_started_at", "mutant_id", desc("started_at")),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    mutant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mutants.id", ondelete="CASCADE"))
    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plans.id", ondelete="RESTRICT"))
    baseline_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), default=None
    )
    outcomes: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    power: Mapped[Decimal | None] = mapped_column(POWER, default=None)
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
