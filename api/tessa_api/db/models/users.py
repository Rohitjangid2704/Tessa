import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, Index, Text, func, true
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from tessa_api.db.base import Base
from tessa_api.db.types import StrEnumType
from tessa_api.ids import new_id
from tessa_api.schemas.enums import UserRole


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('viewer', 'member', 'admin')", name="role"),
        Index(
            "uq_users_oidc_issuer_oidc_subject",
            "oidc_issuer",
            "oidc_subject",
            unique=True,
            postgresql_where=sql_text("oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(CITEXT, unique=True)
    name: Mapped[str] = mapped_column(Text)
    password_hash: Mapped[str | None] = mapped_column(Text, default=None)
    role: Mapped[UserRole] = mapped_column(StrEnumType(UserRole))
    is_active: Mapped[bool] = mapped_column(server_default=true())
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_login_at: Mapped[datetime | None] = mapped_column(default=None)
    oidc_issuer: Mapped[str | None] = mapped_column(Text, default=None)
    oidc_subject: Mapped[str | None] = mapped_column(Text, default=None)
