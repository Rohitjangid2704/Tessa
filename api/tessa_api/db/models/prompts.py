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
from tessa_api.schemas.enums import PromptTemplateName


class PromptTemplateRow(Base):
    __tablename__ = "prompt_templates"
    __table_args__ = (
        UniqueConstraint("name", "version"),
        Index(
            "uq_prompt_templates_current_name",
            "name",
            unique=True,
            postgresql_where=sql_text("is_current"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    name: Mapped[PromptTemplateName] = mapped_column(StrEnumType(PromptTemplateName))
    version: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    variables: Mapped[list[str]] = mapped_column(JSONB, server_default=sql_text("'[]'::jsonb"))
    is_current: Mapped[bool] = mapped_column(server_default=false())
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class PromptIssueRow(Base):
    __tablename__ = "prompt_issues"
    __table_args__ = (
        Index("ix_prompt_issues_target_id_issued_at", "target_id", desc("issued_at")),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    template_name: Mapped[PromptTemplateName] = mapped_column(StrEnumType(PromptTemplateName))
    template_version: Mapped[int] = mapped_column(Integer)
    token: Mapped[str] = mapped_column(Text)
    params: Mapped[dict[str, Any]] = mapped_column(server_default=sql_text("'{}'::jsonb"))
    text: Mapped[str] = mapped_column(Text)
    bundle_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("bundles.id"), default=None)
    finding_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    issued_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    issued_at: Mapped[datetime] = mapped_column(server_default=func.now())
