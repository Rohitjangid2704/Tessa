import uuid
from typing import Any

from sqlalchemy import ForeignKey, Index, Text, UniqueConstraint
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import Confidence, FeatureKind

EMPTY_TEXT_ARRAY = sql_text("'{}'")


class CatalogItemRow(Base):
    __tablename__ = "catalog_items"
    __table_args__ = (
        UniqueConstraint("bundle_id", "feature_id"),
        Index("ix_catalog_items_bundle_id_area", "bundle_id", "area"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    bundle_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bundles.id"))
    feature_id: Mapped[str] = mapped_column(Text)
    area: Mapped[str] = mapped_column(Text)
    kind: Mapped[FeatureKind] = mapped_column(StrEnumType(FeatureKind))
    description: Mapped[str] = mapped_column(Text)
    interface_ids: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=EMPTY_TEXT_ARRAY)
    roles: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=EMPTY_TEXT_ARRAY)
    flag: Mapped[str] = mapped_column(Text)
    preconditions: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=EMPTY_TEXT_ARRAY)
    examples: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, server_default=sql_text("'[]'::jsonb")
    )
    invariants: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=EMPTY_TEXT_ARRAY)
    cleanup: Mapped[str] = mapped_column(Text)
    confidence: Mapped[Confidence] = mapped_column(StrEnumType(Confidence))
    raw: Mapped[dict[str, Any]] = mapped_column()
