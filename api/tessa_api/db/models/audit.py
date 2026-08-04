import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, func, text
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import AuditAction, AuditSubjectType, AuditVia


class AuditEventRow(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_created_at", "created_at"),
        Index("ix_audit_events_subject_type_subject_id", "subject_type", "subject_id"),
        Index("ix_audit_events_agent_session_id", "agent_session_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), default=None
    )
    action: Mapped[AuditAction] = mapped_column(StrEnumType(AuditAction))
    subject_type: Mapped[AuditSubjectType] = mapped_column(StrEnumType(AuditSubjectType))
    subject_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    detail: Mapped[dict[str, Any]] = mapped_column(server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    via: Mapped[AuditVia] = mapped_column(StrEnumType(AuditVia), server_default=text("'web'"))
    agent_session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agent_sessions.id", ondelete="SET NULL"), default=None
    )
