import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, ForeignKey, Index, Integer, Text, UniqueConstraint, desc, func
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import BundleSourceKind, BundleValidationStatus

EMPTY_JSON_ARRAY = sql_text("'[]'::jsonb")
ZERO = sql_text("0")


class BundleRow(Base):
    __tablename__ = "bundles"
    __table_args__ = (
        UniqueConstraint("target_id", "version"),
        UniqueConstraint("target_id", "hash"),
        Index("ix_bundles_target_id_version", "target_id", desc("version")),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    version: Mapped[int] = mapped_column(Integer)
    hash: Mapped[str] = mapped_column(Text)
    source: Mapped[BundleSourceKind] = mapped_column(StrEnumType(BundleSourceKind))
    note: Mapped[str | None] = mapped_column(Text, default=None)
    schema_version: Mapped[int] = mapped_column(Integer)
    validation_status: Mapped[BundleValidationStatus] = mapped_column(
        StrEnumType(BundleValidationStatus)
    )
    errors: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    warnings: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    completeness: Mapped[dict[str, Any]] = mapped_column()
    diff_summary: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    manifest: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    feature_count: Mapped[int] = mapped_column(Integer, server_default=ZERO)
    file_count: Mapped[int] = mapped_column(Integer, server_default=ZERO)
    size_bytes: Mapped[int] = mapped_column(BigInteger, server_default=ZERO)
    scenarios_imported: Mapped[int] = mapped_column(Integer, server_default=ZERO)
    mutants_imported: Mapped[int] = mapped_column(Integer, server_default=ZERO)
    files: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    storage_path: Mapped[str | None] = mapped_column(Text, default=None)
    uploaded_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    uploaded_at: Mapped[datetime] = mapped_column(server_default=func.now())
    commit_sha: Mapped[str | None] = mapped_column(Text, default=None)
    branch: Mapped[str | None] = mapped_column(Text, default=None)
