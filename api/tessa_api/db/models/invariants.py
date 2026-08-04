import uuid
from datetime import datetime

from sqlalchemy import Float, ForeignKey, Index, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import InvariantPack, SkipReason, VerdictStatus, VerdictTier


class InvariantResultRow(Base):
    __tablename__ = "invariant_results"
    __table_args__ = (
        Index(
            "ix_invariant_results_run_id_invariant_id_status", "run_id", "invariant_id", "status"
        ),
        Index("ix_invariant_results_run_scenario_id", "run_scenario_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    run_scenario_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("run_scenarios.id", ondelete="CASCADE"), default=None
    )
    step_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("steps.id", ondelete="SET NULL"), default=None
    )
    attempt: Mapped[int | None] = mapped_column(Integer, default=None)
    invariant_id: Mapped[str] = mapped_column(Text)
    pack: Mapped[InvariantPack] = mapped_column(StrEnumType(InvariantPack))
    status: Mapped[VerdictStatus] = mapped_column(StrEnumType(VerdictStatus))
    tier: Mapped[VerdictTier] = mapped_column(StrEnumType(VerdictTier))
    confidence: Mapped[float | None] = mapped_column(Float, default=None)
    message: Mapped[str] = mapped_column(Text)
    skip_reason: Mapped[SkipReason | None] = mapped_column(StrEnumType(SkipReason), default=None)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
