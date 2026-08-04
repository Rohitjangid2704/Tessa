import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import CandidateSource, CandidateStatus


class ExplorationCandidateRow(Base):
    __tablename__ = "exploration_candidates"
    __table_args__ = (Index("ix_exploration_candidates_run_id_status", "run_id", "status"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    run_scenario_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("run_scenarios.id", ondelete="CASCADE")
    )
    source: Mapped[CandidateSource] = mapped_column(StrEnumType(CandidateSource))
    detector: Mapped[str | None] = mapped_column(Text, default=None)
    description: Mapped[str] = mapped_column(Text)
    from_index: Mapped[int] = mapped_column(Integer)
    to_index: Mapped[int] = mapped_column(Integer)
    assertion: Mapped[dict[str, Any]] = mapped_column()
    status: Mapped[CandidateStatus] = mapped_column(StrEnumType(CandidateStatus))
    finding_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("findings.id", ondelete="SET NULL"), default=None
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    verified_at: Mapped[datetime | None] = mapped_column(default=None)
