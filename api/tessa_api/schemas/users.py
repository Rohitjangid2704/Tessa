from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, Field, SecretStr, StringConstraints

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import UserRole
from tessa_api.schemas.notifications import EmailAddress

USER_NAME_MAX_LENGTH = 200
USER_PASSWORD_MIN_LENGTH = 12
USER_PASSWORD_MAX_LENGTH = 1024

UserName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=USER_NAME_MAX_LENGTH),
]
UserPassword = Annotated[
    SecretStr, Field(min_length=USER_PASSWORD_MIN_LENGTH, max_length=USER_PASSWORD_MAX_LENGTH)
]


class User(BaseModel):
    id: UUID
    email: str
    name: str
    role: UserRole
    is_active: bool
    created_at: Timestamp
    last_login_at: Timestamp | None = Field(
        description="last successful sign in; null when the user never signed in"
    )


class UserPage(BaseModel):
    items: list[User]
    next_cursor: str | None
    total: int | None


class UserCreate(BaseModel):
    email: EmailAddress
    name: UserName
    role: UserRole
    password: UserPassword | None = Field(
        default=None,
        description="absent creates a user that cannot sign in; never returned",
    )


class UserUpdate(BaseModel):
    name: UserName | None = None
    role: UserRole | None = None
    is_active: bool | None = None
