from fastapi import APIRouter

from tessa_api.deps import SessionFactoryDep, service_key_dependency
from tessa_api.schemas.streams import IngestEventBatch, IngestEventResult
from tessa_api.services.mutation_summary import MUTATION_SUMMARY_CACHE
from tessa_api.streams.dependencies import HubDep
from tessa_api.streams.ingest import append_events

MUTATION_OUTCOME_EVENT = "mutation.outcome"

router = APIRouter(
    prefix="/internal/v1",
    tags=["internal"],
    include_in_schema=False,
    dependencies=[service_key_dependency],
)


@router.post("/run-events", response_model=IngestEventResult)
async def ingest_run_events(
    body: IngestEventBatch, session_factory: SessionFactoryDep, hub: HubDep
) -> IngestEventResult:
    result = await append_events(session_factory, hub, body.events)
    if any(event.type == MUTATION_OUTCOME_EVENT for event in body.events):
        MUTATION_SUMMARY_CACHE.clear()
    return result
