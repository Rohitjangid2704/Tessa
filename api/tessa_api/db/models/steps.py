import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, Text, UniqueConstraint, false, func
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.models.runs import EMPTY_JSON_ARRAY, MONEY, ZERO
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import AdapterKind, BrowserSessionStatus


class StepRow(Base):
    __tablename__ = "steps"
    __table_args__ = (
        UniqueConstraint("run_scenario_id", "attempt", "index"),
        Index("ix_steps_run_id", "run_id"),
        Index(
            "ix_steps_finished_at_unpurged",
            "finished_at",
            postgresql_where=sql_text("payload_purged_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    run_scenario_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("run_scenarios.id", ondelete="CASCADE")
    )
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    attempt: Mapped[int] = mapped_column(Integer)
    index: Mapped[int] = mapped_column(Integer)
    adapter: Mapped[AdapterKind] = mapped_column(StrEnumType(AdapterKind))
    label: Mapped[str] = mapped_column(Text)
    request: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    response: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    response_truncated: Mapped[bool] = mapped_column(server_default=false())
    ask: Mapped[str | None] = mapped_column(Text, default=None)
    answer: Mapped[str | None] = mapped_column(Text, default=None)
    tools: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    cards: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    tier0: Mapped[dict[str, Any]] = mapped_column()
    latency_ms: Mapped[int] = mapped_column(Integer)
    cost_usd: Mapped[Decimal] = mapped_column(MONEY, server_default=ZERO)
    artifacts: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    verdict: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    machine_grading: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    gold_points: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, server_default=EMPTY_JSON_ARRAY
    )
    db_checks: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    evidence: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    ok: Mapped[bool | None] = mapped_column(default=None)
    tier0_failure_count: Mapped[int] = mapped_column(Integer, server_default=ZERO)
    screenshot_count: Mapped[int] = mapped_column(Integer, server_default=ZERO)
    started_at: Mapped[datetime]
    finished_at: Mapped[datetime]
    payload_purged_at: Mapped[datetime | None] = mapped_column(default=None)


class BrowserSessionRow(Base):
    __tablename__ = "browser_sessions"
    __table_args__ = (Index("ix_browser_sessions_run_id", "run_id"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    run_scenario_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("run_scenarios.id", ondelete="CASCADE")
    )
    attempt: Mapped[int] = mapped_column(Integer)
    status: Mapped[BrowserSessionStatus] = mapped_column(StrEnumType(BrowserSessionStatus))
    viewport: Mapped[dict[str, Any]] = mapped_column()
    last_url: Mapped[str | None] = mapped_column(Text, default=None)
    recording: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    trace: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(default=None)
