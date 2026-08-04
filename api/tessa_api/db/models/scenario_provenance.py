import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, Text, func
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.ids import new_id

EMPTY_JSON_ARRAY = sql_text("'[]'::jsonb")


class ScenarioProvenanceRow(Base):
    __tablename__ = "scenario_provenance"
    __table_args__ = (
        Index("ix_scenario_provenance_cell_id", "cell_id"),
        Index("ix_scenario_provenance_finding_id", "finding_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    scenario_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scenarios.id", ondelete="CASCADE"), unique=True
    )
    cell_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("coverage_cells.id", ondelete="SET NULL"), default=None
    )
    bundle_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bundles.id"))
    bundle_version: Mapped[int] = mapped_column(Integer)
    finding_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("findings.id", ondelete="SET NULL"), default=None
    )
    ticket_url: Mapped[str | None] = mapped_column(Text, default=None)
    prompt_issue_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prompt_issues.id", ondelete="SET NULL"), default=None
    )
    generator: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    dry_runs: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
