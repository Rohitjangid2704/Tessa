import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from tessa_api.db.session import SessionFactory
from tessa_api.deps import IdempotencyDep, MemberUser, SessionFactoryDep
from tessa_api.errors import error_responses
from tessa_api.ids import new_id
from tessa_api.schemas.common import RunHandle
from tessa_api.schemas.enums import RunKind, RunStatus
from tessa_api.schemas.hello import HelloRunCreate, HelloWorkflowInput
from tessa_api.services.hello import (
    HELLO_WORKFLOW_NAME,
    hello_workflow_id,
    run_created_event,
    run_failed_event,
)
from tessa_api.streams.dependencies import HubDep
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import append_events
from tessa_api.temporal_client import TemporalDep

logger = logging.getLogger("tessa_api.system")

router = APIRouter(tags=["system"])


async def record_failed_start(
    session_factory: SessionFactory, hub: Hub, run_id: UUID, created_at: datetime
) -> None:
    now = datetime.now(UTC)
    duration_ms = round((now - created_at).total_seconds() * 1000)
    try:
        await append_events(session_factory, hub, [run_failed_event(run_id, now, duration_ms)])
    except Exception:
        logger.exception("hello_run_failure_not_recorded", extra={"run_id": str(run_id)})


@router.post(
    "/hello-runs",
    status_code=202,
    response_model=RunHandle,
    summary="Start the hello workflow",
    responses=error_responses(400, 401, 403, 409, 422, 503),
)
async def create_hello_run(
    body: HelloRunCreate,
    user: MemberUser,
    idempotency: IdempotencyDep,
    session_factory: SessionFactoryDep,
    hub: HubDep,
    temporal: TemporalDep,
) -> JSONResponse:
    await temporal.ensure_available()
    run_id = new_id()
    workflow_id = hello_workflow_id(run_id)
    created_at = datetime.now(UTC)
    await append_events(session_factory, hub, [run_created_event(run_id, user.id, created_at)])
    workflow_input = HelloWorkflowInput(
        run_id=run_id,
        ticks=body.ticks,
        tick_interval_ms=body.tick_interval_ms,
        include_laya=body.include_laya,
    )
    try:
        await temporal.start_workflow(HELLO_WORKFLOW_NAME, workflow_input, workflow_id)
    except Exception:
        await record_failed_start(session_factory, hub, run_id, created_at)
        raise
    handle = RunHandle(
        run_id=run_id,
        workflow_id=workflow_id,
        kind=RunKind.hello,
        status=RunStatus.queued,
        created_at=created_at,
    )
    return await idempotency.respond(handle, 202)
