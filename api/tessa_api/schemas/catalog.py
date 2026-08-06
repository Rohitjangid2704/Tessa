from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.enums import AdapterKind, Confidence, FeatureKind, ProposalRisk


class CatalogExample(BaseModel):
    ask: str | None = None
    request: dict[str, Any] | None = None
    expected: str
    oracle: str | None = None


class CatalogItem(BaseModel):
    id: UUID
    bundle_id: UUID
    feature_id: str
    area: str
    kind: FeatureKind
    description: str
    interface_ids: list[str]
    roles: list[str]
    flag: str
    preconditions: list[str]
    examples: list[CatalogExample]
    invariants: list[str]
    cleanup: str
    confidence: Confidence
    writes_to: str | None = None
    confirmation: str | None = None
    expect_db: dict[str, Any] | None = None
    proposal_risk: ProposalRisk | None = Field(
        default=None,
        description="highest risk among the items of the current proposal that name the feature "
        "and were not declined; filled by GET /catalog, null elsewhere",
    )


class CatalogRole(BaseModel):
    id: str
    level: int
    description: str


class CatalogInterface(BaseModel):
    id: str
    kind: AdapterKind
    base_path: str


class CatalogArea(BaseModel):
    name: str
    items: list[CatalogItem]


class Catalog(BaseModel):
    bundle_id: UUID | None
    bundle_version: int | None
    roles: list[CatalogRole]
    interfaces: list[CatalogInterface]
    areas: list[CatalogArea]
