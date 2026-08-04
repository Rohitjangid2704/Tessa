import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, Text, desc, func
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.ids import new_id


class AgentSessionRow(Base):
    __tablename__ = "agent_sessions"
    __table_args__ = (
        Index("ix_agent_sessions_target_id_started_at", "target_id", desc("started_at")),
        Index("ix_agent_sessions_user_id_claude_session_id", "user_id", "claude_session_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    target_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("targets.id", ondelete="SET NULL"), default=None
    )
    claude_session_id: Mapped[str] = mapped_column(Text)
    cwd_label: Mapped[str] = mapped_column(Text)
    plugin_version: Mapped[str] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(default=None)
    summary: Mapped[str | None] = mapped_column(Text, default=None)
    write_count: Mapped[int] = mapped_column(Integer, server_default=sql_text("0"))
