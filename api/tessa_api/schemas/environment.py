from typing import Annotated, Self
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import EnvVarKind
from tessa_api.schemas.health import HealthState

ENV_NAME_MAX_LENGTH = 200
ENV_VALUE_MAX_LENGTH = 65536

EnvironmentName = Annotated[str, Field(max_length=ENV_NAME_MAX_LENGTH)]
EnvironmentValue = Annotated[str, Field(min_length=1, max_length=ENV_VALUE_MAX_LENGTH)]


class EnvironmentVariable(BaseModel):
    name: str
    kind: EnvVarKind
    secret: bool
    required: bool
    purpose: str
    interface_ids: list[str]
    has_value: bool
    value: str | None = Field(default=None, description="present only when secret is false")
    stale: bool = Field(description="true when the latest valid bundle no longer declares it")
    last_set_at: Timestamp | None
    last_set_by: UUID | None
    health: HealthState

    @model_validator(mode="after")
    def refuse_secret_value(self) -> Self:
        if self.secret and self.value is not None:
            raise ValueError("a secret variable never carries its value")
        return self


class EnvironmentList(BaseModel):
    items: list[EnvironmentVariable]
    missing_required: int = Field(
        description="required variables that are not stale and have no value"
    )


class EnvironmentPatch(BaseModel):
    set: dict[EnvironmentName, EnvironmentValue] = Field(
        default_factory=dict, description="variable name to new value; write-only"
    )
    clear: list[EnvironmentName] = Field(
        default_factory=list, description="variable names whose value is removed"
    )
