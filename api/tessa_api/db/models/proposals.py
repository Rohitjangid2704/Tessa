import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, Text, UniqueConstraint, desc, func
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import (
    Confidence,
    Depth,
    ProposalItemStatus,
    ProposalKind,
    ProposalOrigin,
    ProposalRisk,
)

EMPTY_JSON_ARRAY = sql_text("'[]'::jsonb")


class ProposalRow(Base):
    __tablename__ = "proposals"
    __table_args__ = (Index("ix_proposals_target_id_created_at", "target_id", desc("created_at")),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id", ondelete="CASCADE"))
    bundle_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("bundles.id", ondelete="SET NULL"), default=None
    )
    prompt_issue_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prompt_issues.id", ondelete="SET NULL"), default=None
    )
    commit_sha: Mapped[str | None] = mapped_column(Text, default=None)
    branch: Mapped[str | None] = mapped_column(Text, default=None)
    generated_at: Mapped[datetime]
    source: Mapped[ProposalOrigin] = mapped_column(StrEnumType(ProposalOrigin))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class ProposalItemRow(Base):
    __tablename__ = "proposal_items"
    __table_args__ = (UniqueConstraint("proposal_id", "key"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    proposal_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(Integer)
    key: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    area: Mapped[str] = mapped_column(Text)
    feature_ids: Mapped[list[str]] = mapped_column(JSONB)
    interface_id: Mapped[str | None] = mapped_column(Text, default=None)
    kind: Mapped[ProposalKind] = mapped_column(StrEnumType(ProposalKind))
    risk: Mapped[ProposalRisk] = mapped_column(StrEnumType(ProposalRisk))
    reasons: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    needs: Mapped[list[str]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
    depth: Mapped[Depth] = mapped_column(StrEnumType(Depth))
    estimate: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    confidence: Mapped[Confidence] = mapped_column(StrEnumType(Confidence))
    evidence: Mapped[str | None] = mapped_column(Text, default=None)
    status: Mapped[ProposalItemStatus] = mapped_column(StrEnumType(ProposalItemStatus))
    note: Mapped[str | None] = mapped_column(Text, default=None)
    selected_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), default=None
    )
    selected_at: Mapped[datetime | None] = mapped_column(default=None)
    scenario_ids: Mapped[list[str]] = mapped_column(JSONB, server_default=EMPTY_JSON_ARRAY)
