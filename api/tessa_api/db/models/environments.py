import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, LargeBinary, Text, UniqueConstraint, false, true
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import EnvVarKind


class EnvironmentRow(Base):
    __tablename__ = "environments"
    __table_args__ = (UniqueConstraint("target_id", "name"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("targets.id"))
    name: Mapped[str] = mapped_column(Text)
    kind: Mapped[EnvVarKind] = mapped_column(StrEnumType(EnvVarKind))
    secret: Mapped[bool] = mapped_column(server_default=true())
    required: Mapped[bool] = mapped_column(server_default=true())
    purpose: Mapped[str] = mapped_column(Text, server_default=sql_text("''"))
    interface_ids: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=sql_text("'{}'"))
    encrypted_value: Mapped[bytes | None] = mapped_column(LargeBinary, default=None)
    stale: Mapped[bool] = mapped_column(server_default=false())
    last_set_at: Mapped[datetime | None] = mapped_column(default=None)
    last_set_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), default=None)
    last_health: Mapped[dict[str, Any] | None] = mapped_column(default=None)
