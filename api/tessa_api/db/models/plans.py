import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, Text, UniqueConstraint, desc, false, func
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import CellStatus, Depth, SkipReason, VerdictStatus


class PlanRow(Base):
    __tablename__ = "plans"
    __table_args__ = (
        Index("ix_plans_target_id_created_at", "target_id", desc("created_at")),
        Index(
            "uq_plans_target_id_bundle_id_coverage_baseline",
            "target_id",
            "bundle_id",
            unique=True,
            postgresql_where=sql_text("is_coverage_baseline"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    bundle_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bundles.id"))
    name: Mapped[str | None] = mapped_column(Text, default=None)
    saved: Mapped[bool] = mapped_column(server_default=false())
    selection: Mapped[dict[str, Any]] = mapped_column()
    depth: Mapped[Depth] = mapped_column(StrEnumType(Depth))
    k: Mapped[int] = mapped_column(Integer)
    budget: Mapped[dict[str, Any]] = mapped_column()
    schedule_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("schedules.id", ondelete="SET NULL", use_alter=True), default=None
    )
    is_coverage_baseline: Mapped[bool] = mapped_column(server_default=false())
    include_api_fuzz: Mapped[bool] = mapped_column(server_default=false())
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class CoverageCellRow(Base):
    __tablename__ = "coverage_cells"
    __table_args__ = (UniqueConstraint("plan_id", "feature_id", "role", "interface_id"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"))
    feature_id: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(Text)
    interface_id: Mapped[str] = mapped_column(Text)
    family: Mapped[str] = mapped_column(Text)
    status: Mapped[CellStatus] = mapped_column(StrEnumType(CellStatus))
    last_verdict: Mapped[VerdictStatus | None] = mapped_column(
        StrEnumType(VerdictStatus), default=None
    )
    reason: Mapped[str | None] = mapped_column(Text, default=None)
    skip_reason: Mapped[SkipReason | None] = mapped_column(StrEnumType(SkipReason), default=None)
