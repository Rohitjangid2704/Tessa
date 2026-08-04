import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Text, UniqueConstraint, true
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import ScheduleTier

EMPTY_NOTIFY = sql_text("""'{"slack": false}'::jsonb""")


class ScheduleRow(Base):
    __tablename__ = "schedules"
    __table_args__ = (
        UniqueConstraint("temporal_schedule_id"),
        Index("ix_schedules_plan_id", "plan_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plans.id", ondelete="RESTRICT"))
    tier: Mapped[ScheduleTier] = mapped_column(StrEnumType(ScheduleTier))
    cron: Mapped[str | None] = mapped_column(Text, default=None)
    timezone: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(server_default=true())
    budget: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    temporal_schedule_id: Mapped[str] = mapped_column(Text)
    notify: Mapped[dict[str, Any]] = mapped_column(server_default=EMPTY_NOTIFY)
    last_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), default=None
    )
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
