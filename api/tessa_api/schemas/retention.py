from typing import Annotated

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp

RETENTION_MIN_DAYS = 1
RETENTION_MAX_DAYS = 3650

RetentionDays = Annotated[int, Field(ge=RETENTION_MIN_DAYS, le=RETENTION_MAX_DAYS)]


class RetentionPolicy(BaseModel):
    steps_days: RetentionDays = Field(
        description="days after which the request, response and evidence of a step are removed"
    )
    artifacts_days: RetentionDays = Field(
        description="days after which screenshots, recordings and traces are deleted; artifacts "
        "of open findings are never deleted"
    )
    run_events_days: RetentionDays = Field(
        description="days after which persisted run events are deleted"
    )


class RetentionCutoffs(BaseModel):
    steps_before: Timestamp = Field(description="steps finished before this lose their payload")
    artifacts_before: Timestamp = Field(description="artifacts written before this are deleted")
    run_events_before: Timestamp = Field(description="run events older than this are deleted")


class RetentionSweepCounts(BaseModel):
    deleted_steps: int = Field(ge=0, description="steps whose payload the sweep removed")
    deleted_artifacts: int = Field(ge=0, description="artifacts the sweep deleted")
    deleted_events: int = Field(ge=0, description="run events the sweep deleted")


class RetentionSweepResult(RetentionSweepCounts):
    at: Timestamp = Field(description="when the sweep finished")


class RetentionState(BaseModel):
    policy: RetentionPolicy
    last_sweep: RetentionSweepResult | None = Field(
        description="what the last sweep did; null before the first sweep"
    )
