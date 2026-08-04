import base64
import secrets
from datetime import datetime
from typing import Any, ClassVar

from sqlalchemy import MetaData
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.types import DateTime

from tessa_api.ids import new_id

__all__ = ["NAMING_CONVENTION", "Base", "new_id", "new_target_token"]

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

TARGET_TOKEN_PREFIX = "tgt_"
TARGET_TOKEN_BODY_LENGTH = 22


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map: ClassVar[dict[Any, Any]] = {
        datetime: DateTime(timezone=True),
        dict[str, Any]: JSONB,
    }


def new_target_token() -> str:
    body = base64.b32encode(secrets.token_bytes(14)).decode().rstrip("=").lower()
    return f"{TARGET_TOKEN_PREFIX}{body[:TARGET_TOKEN_BODY_LENGTH]}"
