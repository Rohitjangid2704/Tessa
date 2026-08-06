from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import DependencyStatus, HealthCheckStatus


class RootInfo(BaseModel):
    name: str
    status: str


class HealthStatus(BaseModel):
    status: Literal["ok"]


class DependencyCheck(BaseModel):
    status: DependencyStatus
    latency_ms: int | None
    detail: str | None


class DependencyHealth(BaseModel):
    db: DependencyCheck
    temporal: DependencyCheck
    laya: DependencyCheck
    storage: DependencyCheck


class HealthState(BaseModel):
    status: HealthCheckStatus
    checked_at: Timestamp | None
    latency_ms: int | None
    message: str | None


class HealthCheckCreate(BaseModel):
    interface_ids: list[str] | None = Field(
        default=None, description="limit the check to these interfaces; absent checks all"
    )


class HealthReportInterface(BaseModel):
    interface_id: str = Field(description="manifest interface id, or truth:<id> for a truth source")
    kind: str = Field(description="manifest interface kind, or truth_source")
    status: HealthCheckStatus
    latency_ms: int | None = None
    message: str | None = None
    variables: list[str] = Field(description="environment variable names the check used")


class HealthReport(BaseModel):
    target_id: UUID
    checked_at: Timestamp | None = Field(description="null when no health check has run yet")
    interfaces: list[HealthReportInterface]
