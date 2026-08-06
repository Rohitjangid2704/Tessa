from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.enums import UserRole


class AuthUser(BaseModel):
    id: UUID
    email: str
    name: str
    role: UserRole


class CredentialsVerifyRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)
