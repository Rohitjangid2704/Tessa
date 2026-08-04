import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import ForeignKey, Index, Integer, Numeric, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import Effort, ModelCallRole, ModelCallStatus

MONEY = Numeric(12, 6)


class ModelCallRow(Base):
    __tablename__ = "model_calls"
    __table_args__ = (
        Index("ix_model_calls_run_id", "run_id"),
        Index("ix_model_calls_created_at", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), default=None
    )
    step_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("steps.id", ondelete="SET NULL"), default=None
    )
    role: Mapped[ModelCallRole] = mapped_column(StrEnumType(ModelCallRole))
    activity: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    effort: Mapped[Effort | None] = mapped_column(StrEnumType(Effort), default=None)
    input_tokens: Mapped[int] = mapped_column(Integer)
    output_tokens: Mapped[int] = mapped_column(Integer)
    cost_usd: Mapped[Decimal] = mapped_column(MONEY)
    latency_ms: Mapped[int] = mapped_column(Integer)
    status: Mapped[ModelCallStatus] = mapped_column(StrEnumType(ModelCallStatus))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
