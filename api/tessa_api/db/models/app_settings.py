import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, LargeBinary, Text, false, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base


class AppSetting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[Any | None] = mapped_column(JSONB(none_as_null=True), default=None)
    is_secret: Mapped[bool] = mapped_column(server_default=false())
    encrypted_value: Mapped[bytes | None] = mapped_column(LargeBinary, default=None)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), default=None)
