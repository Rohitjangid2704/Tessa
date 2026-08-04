import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import ForeignKey, Index, Integer, Text, func
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.common import EMBEDDING_DIMENSIONS
from tessa_api.schemas.enums import ScenarioOrigin, ScenarioStatus

AUTHORED_KEY_EXPRESSION = sql_text("(provenance ->> 'authored_key')")
HAS_AUTHORED_KEY = sql_text("(provenance ->> 'authored_key') IS NOT NULL")


class ScenarioRow(Base):
    __tablename__ = "scenarios"
    __table_args__ = (
        Index("ix_scenarios_target_id_feature_id", "target_id", "feature_id"),
        Index(
            "ix_scenarios_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
        Index(
            "uq_scenarios_target_id_authored_key",
            "target_id",
            AUTHORED_KEY_EXPRESSION,
            unique=True,
            postgresql_where=HAS_AUTHORED_KEY,
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    bundle_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bundles.id"))
    feature_id: Mapped[str | None] = mapped_column(Text, default=None)
    cell_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("coverage_cells.id", ondelete="SET NULL"), default=None
    )
    title: Mapped[str] = mapped_column(Text)
    family: Mapped[str] = mapped_column(Text)
    origin: Mapped[ScenarioOrigin] = mapped_column(StrEnumType(ScenarioOrigin))
    status: Mapped[ScenarioStatus] = mapped_column(StrEnumType(ScenarioStatus))
    version: Mapped[int] = mapped_column(Integer, server_default=sql_text("1"))
    yaml: Mapped[str] = mapped_column(Text)
    parsed: Mapped[dict[str, Any]] = mapped_column()
    validation: Mapped[dict[str, Any]] = mapped_column()
    provenance: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(EMBEDDING_DIMENSIONS), default=None
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class ScenarioVersionRow(Base):
    __tablename__ = "scenario_versions"

    scenario_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scenarios.id", ondelete="CASCADE"), primary_key=True
    )
    version: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    yaml: Mapped[str] = mapped_column(Text)
    parsed: Mapped[dict[str, Any]] = mapped_column()
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), default=None)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    note: Mapped[str | None] = mapped_column(Text, default=None)
