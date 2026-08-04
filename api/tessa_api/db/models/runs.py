import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    desc,
    false,
    func,
)
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import (
    RunKind,
    RunScenarioStatus,
    RunStatus,
    RunTrigger,
    SkipReason,
)

EMPTY_JSON_ARRAY = sql_text("'[]'::jsonb")
ZERO = sql_text("0")
NON_TERMINAL_WHERE = sql_text("status IN ('queued', 'planning', 'seeding', 'running', 'canceling')")
MONEY = Numeric(12, 6)


class RunRow(Base):
    __tablename__ = "runs"
    __table_args__ = (
        Index("ix_runs_target_id_created_at", "target_id", desc("created_at")),
        Index("ix_runs_status_non_terminal", "status", postgresql_where=NON_TERMINAL_WHERE),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    kind: Mapped[RunKind] = mapped_column(StrEnumType(RunKind))
    target_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("targets.id"), default=None)
    plan_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("plans.id", ondelete="SET NULL"), default=None
    )
    bundle_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("bundles.id"), default=None)
    status: Mapped[RunStatus] = mapped_column(StrEnumType(RunStatus))
    trigger: Mapped[RunTrigger] = mapped_column(StrEnumType(RunTrigger))
    read_only: Mapped[bool] = mapped_column(server_default=false())
    config_snapshot: Mapped[dict[str, Any]] = mapped_column()
    budget: Mapped[dict[str, Any]] = mapped_column()
    spent_usd: Mapped[Decimal] = mapped_column(MONEY, server_default=ZERO)
    counters: Mapped[dict[str, Any]] = mapped_column()
    stats: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    workflow_id: Mapped[str] = mapped_column(Text, unique=True)
    event_head_seq: Mapped[int] = mapped_column(BigInteger, server_default=ZERO)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
    stop_requested_at: Mapped[datetime | None] = mapped_column(default=None)


class RunScenarioRow(Base):
    __tablename__ = "run_scenarios"
    __table_args__ = (
        UniqueConstraint("run_id", "scenario_id", "role", "interface_id"),
        Index("ix_run_scenarios_run_id", "run_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    scenario_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scenarios.id"))
    scenario_version: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(Text)
    interface_id: Mapped[str] = mapped_column(Text)
    attempts_total: Mapped[int] = mapped_column(Integer)
    status: Mapped[RunScenarioStatus] = mapped_column(StrEnumType(RunScenarioStatus))
    verdict: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    skip_reason: Mapped[SkipReason | None] = mapped_column(StrEnumType(SkipReason), default=None)
    attempts: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
