import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, Request
from pydantic import BaseModel
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleAlreadyRunningError,
    SchedulePolicy,
    ScheduleState,
    ScheduleUpdate,
)
from temporalio.client import ScheduleOverlapPolicy as TemporalOverlapPolicy
from temporalio.client import ScheduleSpec as TemporalScheduleSpec
from temporalio.common import WorkflowIDReusePolicy
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from tessa_api.errors import ApiError, dependency_unavailable
from tessa_api.schemas.schedules import ScheduleDescription, ScheduleSpec
from tessa_api.schemas.temporal import (
    RETENTION_SWEEP_SCHEDULE_ID,
    RETENTION_SWEEP_WORKFLOW,
    RETENTION_SWEEP_WORKFLOW_ID,
    SCHEDULE_CATCHUP_WINDOW,
    SCHEDULED_RUN_WORKFLOW,
    RetentionSweepInput,
    ScheduledRunInput,
    scheduled_run_workflow_id,
)

CONNECT_TIMEOUT_SECONDS = 3.0
HEALTH_TIMEOUT_SECONDS = 2.0
START_TIMEOUT_SECONDS = 5.0
SIGNAL_TIMEOUT_SECONDS = 5.0
SCHEDULE_TIMEOUT_SECONDS = 5.0
SCHEDULE_DEADLINE_SECONDS = SCHEDULE_TIMEOUT_SECONDS * 2 + 1
SCHEDULE_NOTE = "Managed by Tessa: change it in the app, not here"
SCHEDULE_DISABLED_NOTE = "Disabled in Tessa"
SCHEDULE_ENABLED_NOTE = "Enabled in Tessa"
RETENTION_SWEEP_CRON = "17 3 * * *"
RETENTION_SWEEP_TIME_ZONE = "UTC"
RETENTION_SWEEP_EXECUTION_TIMEOUT = timedelta(hours=6)
RETENTION_SWEEP_NOTE = "Managed by Tessa: the daily retention sweep"

logger = logging.getLogger("tessa_api.temporal")


class WorkflowNotRunningError(Exception):
    def __init__(self, workflow_id: str) -> None:
        super().__init__(f"workflow {workflow_id} is not running")
        self.workflow_id = workflow_id


class ScheduleNotFoundError(Exception):
    def __init__(self, temporal_schedule_id: str) -> None:
        super().__init__(f"temporal schedule {temporal_schedule_id} does not exist")
        self.temporal_schedule_id = temporal_schedule_id


def temporal_unavailable(reason: str) -> ApiError:
    return dependency_unavailable("temporal", f"Temporal is unavailable: {reason}")


class TemporalGateway:
    def __init__(self, address: str, namespace: str, task_queue: str) -> None:
        self.address = address
        self.namespace = namespace
        self.task_queue = task_queue
        self.client: Client | None = None
        self.connect_lock = asyncio.Lock()

    async def connected_client(self) -> Client:
        if self.client is not None:
            return self.client
        async with self.connect_lock:
            if self.client is None:
                self.client = await self.connect()
            return self.client

    async def connect(self) -> Client:
        try:
            async with asyncio.timeout(CONNECT_TIMEOUT_SECONDS):
                return await Client.connect(
                    self.address,
                    namespace=self.namespace,
                    data_converter=pydantic_data_converter,
                )
        except (TimeoutError, RuntimeError, OSError, RPCError) as error:
            logger.warning("temporal_connect_failed", extra={"error": type(error).__name__})
            raise temporal_unavailable("connection failed") from error

    async def ensure_available(self) -> None:
        client = await self.connected_client()
        try:
            async with asyncio.timeout(HEALTH_TIMEOUT_SECONDS + 1):
                serving = await client.service_client.check_health(
                    timeout=timedelta(seconds=HEALTH_TIMEOUT_SECONDS)
                )
        except (TimeoutError, RPCError) as error:
            raise temporal_unavailable("health check failed") from error
        if not serving:
            raise temporal_unavailable("workflow service is not serving")

    async def start_workflow(
        self,
        name: str,
        argument: BaseModel,
        workflow_id: str,
        execution_timeout: timedelta | None = None,
    ) -> None:
        client = await self.connected_client()
        try:
            async with asyncio.timeout(START_TIMEOUT_SECONDS + 1):
                await client.start_workflow(
                    name,
                    argument,
                    id=workflow_id,
                    task_queue=self.task_queue,
                    execution_timeout=execution_timeout,
                    id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
                    rpc_timeout=timedelta(seconds=START_TIMEOUT_SECONDS),
                )
        except WorkflowAlreadyStartedError as error:
            raise ApiError(
                409, "conflict", f"Workflow {workflow_id} was already started"
            ) from error
        except (TimeoutError, RPCError) as error:
            logger.warning(
                "temporal_start_failed",
                extra={"workflow_id": workflow_id, "error": type(error).__name__},
            )
            raise temporal_unavailable("could not start the workflow") from error

    async def signal_workflow(self, workflow_id: str, signal: str) -> None:
        client = await self.connected_client()
        handle = client.get_workflow_handle(workflow_id)
        try:
            async with asyncio.timeout(SIGNAL_TIMEOUT_SECONDS + 1):
                await handle.signal(signal, rpc_timeout=timedelta(seconds=SIGNAL_TIMEOUT_SECONDS))
        except RPCError as error:
            if error.status is RPCStatusCode.NOT_FOUND:
                raise WorkflowNotRunningError(workflow_id) from error
            logger.warning(
                "temporal_signal_failed",
                extra={"workflow_id": workflow_id, "error": type(error).__name__},
            )
            raise temporal_unavailable("could not signal the workflow") from error
        except TimeoutError as error:
            raise temporal_unavailable("could not signal the workflow") from error

    def schedule_definition(self, spec: ScheduleSpec) -> Schedule:
        return Schedule(
            action=ScheduleActionStartWorkflow(
                SCHEDULED_RUN_WORKFLOW,
                ScheduledRunInput(schedule_id=spec.schedule_id),
                id=scheduled_run_workflow_id(spec.schedule_id),
                task_queue=self.task_queue,
            ),
            spec=TemporalScheduleSpec(
                cron_expressions=[] if spec.cron is None else [spec.cron],
                time_zone_name=spec.timezone,
            ),
            policy=SchedulePolicy(
                overlap=TemporalOverlapPolicy.SKIP, catchup_window=SCHEDULE_CATCHUP_WINDOW
            ),
            state=ScheduleState(
                note=SCHEDULE_DISABLED_NOTE if spec.paused else SCHEDULE_NOTE, paused=spec.paused
            ),
        )

    async def schedule_call[T](
        self, operation: str, temporal_schedule_id: str, call: Callable[[], Awaitable[T]]
    ) -> T:
        try:
            async with asyncio.timeout(SCHEDULE_DEADLINE_SECONDS):
                return await call()
        except RPCError as error:
            if error.status is RPCStatusCode.NOT_FOUND:
                raise ScheduleNotFoundError(temporal_schedule_id) from error
            self.log_schedule_failure(operation, temporal_schedule_id, error)
            raise temporal_unavailable(f"could not {operation} the schedule") from error
        except TimeoutError as error:
            self.log_schedule_failure(operation, temporal_schedule_id, error)
            raise temporal_unavailable(f"could not {operation} the schedule") from error

    def log_schedule_failure(
        self, operation: str, temporal_schedule_id: str, error: Exception
    ) -> None:
        logger.warning(
            "temporal_schedule_failed",
            extra={
                "operation": operation,
                "temporal_schedule_id": temporal_schedule_id,
                "error": type(error).__name__,
            },
        )

    async def create_schedule(self, spec: ScheduleSpec) -> None:
        client = await self.connected_client()
        definition = self.schedule_definition(spec)
        try:
            await self.schedule_call(
                "create",
                spec.temporal_schedule_id,
                lambda: client.create_schedule(
                    spec.temporal_schedule_id,
                    definition,
                    rpc_timeout=timedelta(seconds=SCHEDULE_TIMEOUT_SECONDS),
                ),
            )
        except ScheduleAlreadyRunningError:
            await self.update_schedule(spec)

    def retention_sweep_definition(self) -> Schedule:
        return Schedule(
            action=ScheduleActionStartWorkflow(
                RETENTION_SWEEP_WORKFLOW,
                RetentionSweepInput(),
                id=RETENTION_SWEEP_WORKFLOW_ID,
                task_queue=self.task_queue,
                execution_timeout=RETENTION_SWEEP_EXECUTION_TIMEOUT,
            ),
            spec=TemporalScheduleSpec(
                cron_expressions=[RETENTION_SWEEP_CRON], time_zone_name=RETENTION_SWEEP_TIME_ZONE
            ),
            policy=SchedulePolicy(
                overlap=TemporalOverlapPolicy.SKIP, catchup_window=SCHEDULE_CATCHUP_WINDOW
            ),
            state=ScheduleState(note=RETENTION_SWEEP_NOTE),
        )

    async def ensure_retention_sweep_schedule(self) -> bool:
        client = await self.connected_client()
        definition = self.retention_sweep_definition()
        try:
            await self.schedule_call(
                "create",
                RETENTION_SWEEP_SCHEDULE_ID,
                lambda: client.create_schedule(
                    RETENTION_SWEEP_SCHEDULE_ID,
                    definition,
                    rpc_timeout=timedelta(seconds=SCHEDULE_TIMEOUT_SECONDS),
                ),
            )
        except ScheduleAlreadyRunningError:
            return False
        return True

    async def update_schedule(self, spec: ScheduleSpec) -> None:
        client = await self.connected_client()
        definition = self.schedule_definition(spec)
        handle = client.get_schedule_handle(spec.temporal_schedule_id)
        await self.schedule_call(
            "update",
            spec.temporal_schedule_id,
            lambda: handle.update(
                lambda _description: ScheduleUpdate(schedule=definition),
                rpc_timeout=timedelta(seconds=SCHEDULE_TIMEOUT_SECONDS),
            ),
        )

    async def delete_schedule(self, temporal_schedule_id: str) -> None:
        client = await self.connected_client()
        handle = client.get_schedule_handle(temporal_schedule_id)
        try:
            await self.schedule_call(
                "delete",
                temporal_schedule_id,
                lambda: handle.delete(rpc_timeout=timedelta(seconds=SCHEDULE_TIMEOUT_SECONDS)),
            )
        except ScheduleNotFoundError:
            return

    async def pause_schedule(self, temporal_schedule_id: str) -> None:
        client = await self.connected_client()
        handle = client.get_schedule_handle(temporal_schedule_id)
        await self.schedule_call(
            "pause",
            temporal_schedule_id,
            lambda: handle.pause(
                note=SCHEDULE_DISABLED_NOTE, rpc_timeout=timedelta(seconds=SCHEDULE_TIMEOUT_SECONDS)
            ),
        )

    async def unpause_schedule(self, temporal_schedule_id: str) -> None:
        client = await self.connected_client()
        handle = client.get_schedule_handle(temporal_schedule_id)
        await self.schedule_call(
            "unpause",
            temporal_schedule_id,
            lambda: handle.unpause(
                note=SCHEDULE_ENABLED_NOTE, rpc_timeout=timedelta(seconds=SCHEDULE_TIMEOUT_SECONDS)
            ),
        )

    async def trigger_schedule(self, temporal_schedule_id: str) -> None:
        client = await self.connected_client()
        handle = client.get_schedule_handle(temporal_schedule_id)
        await self.schedule_call(
            "trigger",
            temporal_schedule_id,
            lambda: handle.trigger(rpc_timeout=timedelta(seconds=SCHEDULE_TIMEOUT_SECONDS)),
        )

    async def describe_schedule(self, temporal_schedule_id: str) -> ScheduleDescription | None:
        client = await self.connected_client()
        handle = client.get_schedule_handle(temporal_schedule_id)
        try:
            description = await self.schedule_call(
                "describe",
                temporal_schedule_id,
                lambda: handle.describe(rpc_timeout=timedelta(seconds=SCHEDULE_TIMEOUT_SECONDS)),
            )
        except ScheduleNotFoundError:
            return None
        spec = description.schedule.spec
        upcoming = description.info.next_action_times
        recent = description.info.recent_actions
        return ScheduleDescription(
            temporal_schedule_id=temporal_schedule_id,
            cron=spec.cron_expressions[0] if spec.cron_expressions else None,
            timezone=spec.time_zone_name,
            paused=description.schedule.state.paused,
            next_run_at=upcoming[0] if upcoming else None,
            last_run_at=recent[-1].started_at if recent else None,
        )


def get_temporal(request: Request) -> TemporalGateway:
    gateway: TemporalGateway = request.app.state.temporal
    return gateway


TemporalDep = Annotated[TemporalGateway, Depends(get_temporal)]
