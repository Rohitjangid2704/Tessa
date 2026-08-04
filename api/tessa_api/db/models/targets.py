import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, ForeignKey, Text, false, func, text
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base, new_target_token
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import AppKind, TargetTier


class Target(Base):
    __tablename__ = "targets"
    __table_args__ = (CheckConstraint("tier IN ('qa', 'production')", name="tier"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(Text)
    slug: Mapped[str] = mapped_column(Text, unique=True)
    app_kind: Mapped[AppKind] = mapped_column(StrEnumType(AppKind))
    tier: Mapped[TargetTier] = mapped_column(
        StrEnumType(TargetTier), default=TargetTier.qa, server_default=TargetTier.qa.value
    )
    allow_production: Mapped[bool] = mapped_column(server_default=false())
    target_token: Mapped[str] = mapped_column(Text, unique=True, default=new_target_token)
    hints: Mapped[dict[str, Any]] = mapped_column(server_default=text("'{}'::jsonb"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    archived_at: Mapped[datetime | None] = mapped_column(default=None)
    previous_target_token: Mapped[str | None] = mapped_column(Text, unique=True, default=None)
    health_report: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    health_checked_at: Mapped[datetime | None] = mapped_column(default=None)
