import logging

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import RunRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import ErrorResponse, RunCounters
from tessa_api.schemas.schedules import ScheduledRunStart, ScheduledRunStarted
from tessa_worker.activities.run_status import TERMINAL_RUN_STATUSES
from tessa_worker.activities.schedule_run_models import (
    CREATE_SCHEDULED_RUN,
    LOAD_SCHEDULED_RUN_OUTCOME,
    ScheduledRunOutcome,
    ScheduledRunOutcomeInput,
)
from tessa_worker.event_client import RETRYABLE_CLIENT_ERRORS, SERVICE_KEY_HEADER
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.schedule_run")

SCHEDULED_RUNS_PATH = "/internal/v1/scheduled-runs"
REQUEST_TIMEOUT_SECONDS = 45.0
REJECTED_TYPE = "scheduled_run_rejected"


def rejection_of(response: httpx.Response) -> ApplicationError:
    try:
        error = ErrorResponse.model_validate(response.json()).error
    except ValueError:
        return ApplicationError(
            f"the API refused to create the scheduled run with HTTP {response.status_code}",
            type=REJECTED_TYPE,
            non_retryable=True,
        )
    return ApplicationError(error.message, type=error.code, non_retryable=True)


class ScheduleRunActivities:
    def __init__(
        self, settings: WorkerSettings, http: httpx.AsyncClient, session_factory: SessionFactory
    ) -> None:
        self.settings = settings
        self.http = http
        self.session_factory = session_factory

    @activity.defn(name=CREATE_SCHEDULED_RUN)
    async def create_scheduled_run(self, request: ScheduledRunStart) -> ScheduledRunStarted:
        response = await self.http.post(
            f"{self.settings.api_internal_url}{SCHEDULED_RUNS_PATH}",
            json=request.model_dump(mode="json"),
            headers={SERVICE_KEY_HEADER: self.settings.service_key.get_secret_value()},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        if response.is_success:
            return ScheduledRunStarted.model_validate(response.json())
        if response.is_client_error and response.status_code not in RETRYABLE_CLIENT_ERRORS:
            raise rejection_of(response)
        logger.warning(
            "scheduled_run_not_created",
            extra={"schedule_id": str(request.schedule_id), "status": response.status_code},
        )
        response.raise_for_status()
        raise ApplicationError(f"unexpected HTTP {response.status_code} creating a scheduled run")

    @activity.defn(name=LOAD_SCHEDULED_RUN_OUTCOME)
    async def load_scheduled_run_outcome(
        self, request: ScheduledRunOutcomeInput
    ) -> ScheduledRunOutcome:
        async with self.session_factory() as session:
            row = await session.get(RunRow, request.run_id)
            if row is None:
                raise ApplicationError(f"run {request.run_id} does not exist", non_retryable=True)
            return ScheduledRunOutcome(
                status=row.status,
                counters=RunCounters.model_validate(row.counters),
                terminal=row.status in TERMINAL_RUN_STATUSES,
            )
