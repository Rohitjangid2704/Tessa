from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import update
from sqlalchemy.dialects.postgresql import insert

from tessa_api.db.models import BrowserSessionRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.artifacts import StoredArtifact
from tessa_api.schemas.enums import ArtifactKind
from tessa_api.schemas.steps import BrowserStepResponse, Tier0Result
from tessa_api.services.artifact_store import ArtifactStore
from tessa_api.services.budget import to_money
from tessa_worker.adapters.base import ProducedArtifact, StepRecord


@dataclass(frozen=True, slots=True)
class RecordedStep:
    step_id: UUID
    index: int
    screenshots: int
    trace: StoredArtifact | None


def merge_records(records: Sequence[StepRecord], label: str) -> StepRecord:
    first, last = records[0], records[-1]
    failed = next((record for record in records if record.ok is False), None)
    return first.model_copy(
        update={
            "label": label,
            "response": last.response,
            "response_truncated": any(record.response_truncated for record in records),
            "ok": False if failed is not None else last.ok,
            "error": None if failed is None else failed.error,
            "latency_ms": sum(record.latency_ms for record in records),
            "cost_usd": sum(record.cost_usd for record in records),
            "artifacts": [item for record in records for item in record.artifacts],
            "finished_at": last.finished_at,
        }
    )


class StepRecorder:
    def __init__(
        self,
        session_factory: SessionFactory,
        artifacts: ArtifactStore,
        run_id: UUID,
        run_scenario_id: UUID,
        attempt: int,
        browser_session_id: UUID,
    ) -> None:
        self.session_factory = session_factory
        self.artifacts = artifacts
        self.run_id = run_id
        self.run_scenario_id = run_scenario_id
        self.attempt = attempt
        self.browser_session_id = browser_session_id

    async def file_artifacts(self, produced: Sequence[ProducedArtifact]) -> list[StoredArtifact]:
        stored: list[StoredArtifact] = []
        for item in produced:
            stored.append(await self.artifacts.put(new_id(), item.path, item.kind, item.mime))
            item.path.unlink(missing_ok=True)
        return stored

    async def persist(
        self, index: int, record: StepRecord, request_extras: Mapping[str, JsonValue]
    ) -> RecordedStep:
        stored = await self.file_artifacts(record.artifacts)
        screenshots = sum(item.kind is ArtifactKind.screenshot for item in stored)
        request = {**record.request.model_dump(mode="json"), **request_extras}
        values: dict[str, Any] = {
            "run_scenario_id": self.run_scenario_id,
            "run_id": self.run_id,
            "attempt": self.attempt,
            "index": index,
            "adapter": record.adapter,
            "label": record.label,
            "request": request,
            "response": None
            if record.response is None
            else record.response.model_dump(mode="json"),
            "response_truncated": record.response_truncated,
            "ask": record.ask,
            "answer": record.answer,
            "tools": [],
            "cards": [],
            "tier0": Tier0Result(passed=True, failures=[]).model_dump(mode="json"),
            "latency_ms": record.latency_ms,
            "cost_usd": to_money(record.cost_usd),
            "artifacts": [item.model_dump(mode="json") for item in stored],
            "ok": record.ok,
            "tier0_failure_count": 0,
            "screenshot_count": screenshots,
            "started_at": record.started_at,
            "finished_at": record.finished_at,
        }
        async with self.session_factory() as session:
            step_id = await session.scalar(
                insert(StepRow)
                .values(id=new_id(), **values)
                .on_conflict_do_update(
                    index_elements=[StepRow.run_scenario_id, StepRow.attempt, StepRow.index],
                    set_=values,
                )
                .returning(StepRow.id)
            )
            if isinstance(record.response, BrowserStepResponse):
                await session.execute(
                    update(BrowserSessionRow)
                    .where(BrowserSessionRow.id == self.browser_session_id)
                    .values(last_url=record.response.url)
                )
            await session.commit()
        if step_id is None:
            raise RuntimeError("the step upsert returned no id")
        trace = next((item for item in stored if item.kind is ArtifactKind.trace), None)
        return RecordedStep(step_id=step_id, index=index, screenshots=screenshots, trace=trace)
