import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.models.runs import EMPTY_JSON_ARRAY
from tessa_api.ids import new_id


class SimSessionRow(Base):
    __tablename__ = "sim_sessions"
    __table_args__ = (
        UniqueConstraint("run_id", "attempt"),
        Index("ix_sim_sessions_persona_id", "persona_id"),
        Index("ix_sim_sessions_goal_id", "goal_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    persona_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("personas.id"))
    goal_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("goals.id"))
    attempt: Mapped[int] = mapped_column(Integer)
    transcript: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    checks: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    verdict: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
