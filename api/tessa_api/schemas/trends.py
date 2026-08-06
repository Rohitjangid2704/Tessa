from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import TrendMetric


class TrendPoint(BaseModel):
    ts: Timestamp = Field(description="finish time of the run the value belongs to")
    value: float
    run_id: UUID | None


class TrendSeries(BaseModel):
    metric: TrendMetric
    points: list[TrendPoint] = Field(description="oldest first")
