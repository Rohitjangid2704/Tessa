from uuid import UUID

from pydantic import BaseModel

from tessa_api.schemas.common import RunCounters
from tessa_api.schemas.enums import RunStatus

CREATE_SCHEDULED_RUN = "create_scheduled_run"
LOAD_SCHEDULED_RUN_OUTCOME = "load_scheduled_run_outcome"


class ScheduledRunOutcomeInput(BaseModel):
    run_id: UUID


class ScheduledRunOutcome(BaseModel):
    status: RunStatus
    counters: RunCounters
    terminal: bool
