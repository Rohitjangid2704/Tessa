from typing import Annotated, Any
from uuid import UUID

from pydantic import BaseModel, Field, StringConstraints

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import AppKind, HealthCheckStatus, TargetTier

TARGET_NAME_MAX_LENGTH = 120
TargetName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=TARGET_NAME_MAX_LENGTH),
]


class TargetCreate(BaseModel):
    name: TargetName
    app_kind: AppKind
    tier: TargetTier | None = None
    hints: dict[str, Any] | None = None


class TargetUpdate(BaseModel):
    name: TargetName | None = None
    app_kind: AppKind | None = None
    tier: TargetTier | None = None
    allow_production: bool | None = None
    hints: dict[str, Any] | None = None


class Target(BaseModel):
    id: UUID
    name: str
    slug: str
    app_kind: AppKind
    tier: TargetTier
    allow_production: bool
    target_token: str
    hints: dict[str, Any]
    latest_bundle_id: UUID | None = None
    created_at: Timestamp
    archived_at: Timestamp | None = None


class TargetSummary(BaseModel):
    id: UUID
    name: str
    slug: str
    app_kind: AppKind
    tier: TargetTier
    latest_bundle_version: int | None
    completeness_score: int | None
    health: HealthCheckStatus
    created_at: Timestamp
    archived_at: Timestamp | None = None


class TargetPage(BaseModel):
    items: list[TargetSummary]
    next_cursor: str | None
    total: int | None


class AppKindHint(BaseModel):
    id: str = Field(description="stable hint id sent as hint_ids of the Discovery prompt")
    label: str
    default_on: bool


class AppKindOption(BaseModel):
    kind: AppKind
    label: str
    hints: list[AppKindHint]


class AppKindList(BaseModel):
    items: list[AppKindOption]
