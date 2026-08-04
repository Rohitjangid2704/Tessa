import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import AttackOutcome


class AttackRow(Base):
    __tablename__ = "attacks"
    __table_args__ = (
        Index("ix_attacks_run_id_outcome", "run_id", "outcome"),
        Index("ix_attacks_round_id", "round_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    round_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    family: Mapped[str] = mapped_column(Text)
    prompt_excerpt: Mapped[str] = mapped_column(Text)
    response_excerpt: Mapped[str] = mapped_column(Text)
    outcome: Mapped[AttackOutcome] = mapped_column(StrEnumType(AttackOutcome))
    skeptic_verdict: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    finding_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("findings.id", ondelete="SET NULL"), default=None
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
