from datetime import UTC, datetime

import httpx
from temporalio import activity

from tessa_api.schemas.hello import EmitRunEventInput, EmitRunEventResult
from tessa_api.schemas.streams import IngestEvent
from tessa_worker.activities.names import EMIT_RUN_EVENT
from tessa_worker.event_client import EventClient
from tessa_worker.settings import WorkerSettings


class EventActivities:
    def __init__(self, settings: WorkerSettings, http: httpx.AsyncClient) -> None:
        self.client = EventClient(settings, http)

    @activity.defn(name=EMIT_RUN_EVENT)
    async def emit_run_event(self, request: EmitRunEventInput) -> EmitRunEventResult:
        result = await self.client.post(
            [
                IngestEvent(
                    run_id=request.run_id,
                    type=request.type,
                    payload=request.payload,
                    dedupe_key=request.dedupe_key,
                    occurred_at=datetime.now(UTC),
                    ephemeral=request.ephemeral,
                )
            ]
        )
        return EmitRunEventResult(seq=result.seqs[0])
