from datetime import timedelta

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp

LOAD_RETENTION_PLAN = "load_retention_plan"
PURGE_STEP_PAYLOADS = "purge_step_payloads"
PURGE_ARTIFACTS = "purge_artifacts"
PURGE_RUN_EVENTS = "purge_run_events"
RECORD_RETENTION_SWEEP = "record_retention_sweep"

RETENTION_PLAN_START_TO_CLOSE = timedelta(seconds=30)
RETENTION_BATCH_START_TO_CLOSE = timedelta(minutes=15)
RETENTION_HEARTBEAT_TIMEOUT = timedelta(minutes=5)
RETENTION_ACTIVITY_MAX_ATTEMPTS = 3
RETENTION_MAX_CALLS_PER_PHASE = 400
RETENTION_CALL_MAX_BATCHES = 20
RETENTION_CALL_MAX_SECONDS = 300.0
RETENTION_ARTIFACT_SCAN_LIMIT = 20_000


class PurgeBatchInput(BaseModel):
    before: Timestamp = Field(description="rows older than this are purged")


class PurgeBatchResult(BaseModel):
    purged: int = Field(ge=0, description="rows this call purged")
    more: bool = Field(description="true when the call stopped at its cap with rows left")


class PurgeArtifactsInput(BaseModel):
    before: Timestamp = Field(description="artifacts written before this are deleted")
    after: str | None = Field(
        default=None, description="storage key the previous call stopped at; absent starts over"
    )


class PurgeArtifactsResult(BaseModel):
    deleted: int = Field(ge=0, description="artifacts this call deleted")
    scanned: int = Field(ge=0, description="storage objects this call looked at")
    after: str | None = Field(description="storage key to continue from")
    more: bool = Field(description="true when the call stopped at its cap before the end")
