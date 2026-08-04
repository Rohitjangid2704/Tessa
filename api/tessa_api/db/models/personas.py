import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Text, UniqueConstraint, desc, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.models.runs import EMPTY_JSON_ARRAY
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import GoalKind


class PersonaRow(Base):
    __tablename__ = "personas"
    __table_args__ = (
        UniqueConstraint("target_id", "name"),
        Index("ix_personas_target_id_created_at", "target_id", desc("created_at")),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    traits: Mapped[dict[str, Any]] = mapped_column()
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class GoalRow(Base):
    __tablename__ = "goals"
    __table_args__ = (Index("ix_goals_target_id_created_at", "target_id", desc("created_at")),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    title: Mapped[str] = mapped_column(Text)
    kind: Mapped[GoalKind] = mapped_column(StrEnumType(GoalKind))
    statement: Mapped[str] = mapped_column(Text)
    success_criteria: Mapped[list[str]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    role: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
