import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Index, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base


class RunEventRow(Base):
    __tablename__ = "run_events"
    __table_args__ = (
        UniqueConstraint("run_id", "seq"),
        UniqueConstraint("run_id", "dedupe_key"),
        Index("ix_run_events_ts", "ts"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[uuid.UUID]
    seq: Mapped[int] = mapped_column(BigInteger)
    type: Mapped[str] = mapped_column(Text)
    ts: Mapped[datetime]
    payload: Mapped[dict[str, Any]]
    dedupe_key: Mapped[str] = mapped_column(Text)
