from pydantic import BaseModel, Field

from tessa_api.schemas.common import Probability, Timestamp
from tessa_api.schemas.enums import CalibrationKind


class CalibrationItem(BaseModel):
    subject: str = Field(
        description="probe id, or the judge as family and rubric version, such as openai:v1"
    )
    kind: CalibrationKind
    n_labels: int = Field(
        ge=0, description="pairs of a human label and a machine value that both decided"
    )
    kappa: float | None = Field(
        ge=-1,
        le=1,
        description="binary Cohen's kappa; null below the minimum label count or when the "
        "labels are too skewed to measure",
    )
    agreement: Probability | None = Field(
        description="raw agreement including uncertain; null when there is no pair at all"
    )


class CalibrationReport(BaseModel):
    generated_at: Timestamp
    min_labels: int = Field(
        ge=1, description="decided pairs an item needs before its kappa is reported"
    )
    items: list[CalibrationItem]
