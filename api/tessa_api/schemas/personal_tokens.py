from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from tessa_api.schemas.common import Timestamp

TOKEN_NAME_MAX_LENGTH = 60
PersonalTokenState = Literal["active", "expired", "revoked"]


class PersonalTokenCreate(BaseModel):
    name: str = Field(
        min_length=1,
        max_length=TOKEN_NAME_MAX_LENGTH,
        description="what the token is for, for example the laptop it lives on",
    )
    expires_in_days: int | None = Field(
        default=None,
        ge=1,
        description="lifetime in days; absent uses TESSA_PERSONAL_TOKEN_MAX_DAYS, which is "
        "also the ceiling: a larger value is 422 validation_failed",
    )

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("name must not be blank")
        return stripped


class PersonalToken(BaseModel):
    id: UUID
    user_id: UUID
    name: str
    prefix: str = Field(
        description="first characters of the token, enough to recognise it and never enough to "
        "use it"
    )
    created_at: Timestamp
    expires_at: Timestamp
    last_used_at: Timestamp | None = Field(
        description="last request made with the token, written at most once a minute"
    )
    revoked_at: Timestamp | None
    state: PersonalTokenState = Field(description="state at the time of the response")


class PersonalTokenCreated(BaseModel):
    token: str = Field(
        description="the full token, ipt_ followed by 43 characters; shown once and never "
        "returned again"
    )
    item: PersonalToken


class PersonalTokenList(BaseModel):
    items: list[PersonalToken]
