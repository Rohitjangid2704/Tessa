import asyncio
import uuid
from collections import defaultdict

from sqlalchemy import select

from tessa_api.db.models import ProbeResultRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.grading import ProbeBatchResult
from tessa_api.schemas.temporal import RunLayaProbesInput
from tessa_worker.invariants.contracts import ProbeRunner


class StepProbeRunner:
    def __init__(self, delegate: ProbeRunner, session_factory: SessionFactory) -> None:
        self.delegate = delegate
        self.session_factory = session_factory
        self.asked: dict[uuid.UUID, list[str]] = {}
        self.locks: defaultdict[uuid.UUID, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def run_laya_probes(self, request: RunLayaProbesInput) -> ProbeBatchResult:
        async with self.locks[request.step_id]:
            known = self.asked.get(request.step_id)
            if known is None:
                known = await self.stored_probe_ids(request.step_id)
            wanted = list(dict.fromkeys([*known, *request.probe_ids]))
            batch = await self.delegate.run_laya_probes(
                RunLayaProbesInput(step_id=request.step_id, probe_ids=wanted)
            )
            self.asked[request.step_id] = wanted
        requested = set(request.probe_ids)
        return ProbeBatchResult(
            results=[result for result in batch.results if result.probe_id in requested]
        )

    async def stored_probe_ids(self, step_id: uuid.UUID) -> list[str]:
        async with self.session_factory() as session:
            return list(
                await session.scalars(
                    select(ProbeResultRow.probe_id)
                    .where(ProbeResultRow.step_id == step_id)
                    .order_by(ProbeResultRow.probe_id)
                )
            )
