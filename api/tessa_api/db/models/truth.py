import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, Text, UniqueConstraint, desc, false, func
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import (
    OracleApproval,
    OracleLanguage,
    OracleResultStatus,
    SeedHashSource,
    SeedResetStatus,
)

EMPTY_JSON_ARRAY = sql_text("'[]'::jsonb")


class SeedRow(Base):
    __tablename__ = "seeds"
    __table_args__ = (UniqueConstraint("target_id", "version"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    bundle_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bundles.id"))
    version: Mapped[int] = mapped_column(Integer)
    declared_hash: Mapped[str | None] = mapped_column(Text, default=None)
    hash_source: Mapped[SeedHashSource] = mapped_column(StrEnumType(SeedHashSource))
    reset_script_path: Mapped[str | None] = mapped_column(Text, default=None)
    hash_command: Mapped[str | None] = mapped_column(Text, default=None)
    material_sha256: Mapped[str] = mapped_column(Text)
    observed_hash: Mapped[str | None] = mapped_column(Text, default=None)
    last_reset_at: Mapped[datetime | None] = mapped_column(default=None)
    last_reset_status: Mapped[SeedResetStatus | None] = mapped_column(
        StrEnumType(SeedResetStatus), default=None
    )
    last_reset_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), default=None
    )


class OracleTemplateRow(Base):
    __tablename__ = "oracle_templates"
    __table_args__ = (UniqueConstraint("bundle_id", "name"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    bundle_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bundles.id"))
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    name: Mapped[str] = mapped_column(Text)
    feature_ids: Mapped[list[str]] = mapped_column(JSONB)
    language: Mapped[OracleLanguage] = mapped_column(StrEnumType(OracleLanguage))
    source: Mapped[str] = mapped_column(Text)
    params_schema: Mapped[dict[str, Any]] = mapped_column()
    sentence_template: Mapped[str] = mapped_column(Text)
    read_only_verified: Mapped[bool] = mapped_column(server_default=false())
    approval: Mapped[OracleApproval] = mapped_column(
        StrEnumType(OracleApproval), server_default=OracleApproval.unreviewed.value
    )
    truth_source: Mapped[str | None] = mapped_column(Text, default=None)
    gold_points: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, server_default=EMPTY_JSON_ARRAY
    )


class OracleResultRow(Base):
    __tablename__ = "oracle_results"
    __table_args__ = (
        Index(
            "ix_oracle_results_oracle_template_id_created_at",
            "oracle_template_id",
            desc("created_at"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    oracle_template_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("oracle_templates.id", ondelete="CASCADE")
    )
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), default=None
    )
    params: Mapped[dict[str, Any]] = mapped_column()
    status: Mapped[OracleResultStatus] = mapped_column(StrEnumType(OracleResultStatus))
    rows: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    rows_truncated: Mapped[bool] = mapped_column(server_default=false())
    sentence: Mapped[str | None] = mapped_column(Text, default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    duration_ms: Mapped[int | None] = mapped_column(Integer, default=None)
    executed_at: Mapped[datetime | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
