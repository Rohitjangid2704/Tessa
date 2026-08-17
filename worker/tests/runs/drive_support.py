import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from tessa_api.schemas.common import Viewport
from tessa_api.schemas.enums import AdapterKind, ArtifactKind
from tessa_api.schemas.health import HealthState
from tessa_api.schemas.scenario import ScenarioStep
from tessa_api.schemas.steps import (
    BrowserStepRequest,
    BrowserStepResponse,
    HttpStepRequest,
    HttpStepResponse,
    Tier0Result,
)
from tessa_worker.activities.drive_ports import (
    AdapterOpenRequest,
    OpenedAdapter,
    PreparedStep,
    StepAssessment,
    StepContext,
)
from tessa_worker.adapters.base import ProducedArtifact, StepRecord, TargetTrace
from tessa_worker.checks.contracts import Tier0Context

StepScript = Callable[[ScenarioStep, int], Awaitable[StepRecord]]
SECRET = "super-secret-token-123456"


def now() -> datetime:
    return datetime.now(UTC)


def http_record(
    label: str = "GET /items",
    status: int = 200,
    ok: bool | None = True,
    cost_usd: float = 0.0,
    latency_ms: int = 12,
    artifacts: Sequence[ProducedArtifact] = (),
    error: str | None = None,
) -> StepRecord:
    moment = now()
    return StepRecord(
        adapter=AdapterKind.http,
        label=label,
        request=HttpStepRequest(
            kind="http",
            method="GET",
            url="http://target.test/items",
            headers={},
            query=None,
            body=None,
        ),
        response=HttpStepResponse(
            kind="http", status=status, headers={}, body={"items": []}, body_text=None
        ),
        ok=ok,
        error=error,
        latency_ms=latency_ms,
        cost_usd=cost_usd,
        artifacts=list(artifacts),
        started_at=moment,
        finished_at=moment,
    )


def browser_record(label: str = "open page", url: str = "http://target.test/chat") -> StepRecord:
    moment = now()
    return StepRecord(
        adapter=AdapterKind.browser,
        label=label,
        request=BrowserStepRequest(
            kind="browser", action="navigate", target=None, text=None, url=url
        ),
        response=BrowserStepResponse(
            kind="browser",
            url=url,
            title="Chat",
            text_excerpt="hello",
            console=[],
            dom_state=None,
        ),
        ok=True,
        latency_ms=30,
        started_at=moment,
        finished_at=moment,
    )


@dataclass
class FakeAdapter:
    kind: AdapterKind = AdapterKind.http
    script: StepScript | None = None
    records: list[StepRecord] = field(default_factory=list)
    driven: list[ScenarioStep] = field(default_factory=list)
    closed: int = 0
    viewport: Viewport = field(default_factory=lambda: Viewport(width=1280, height=720))
    session_files: list[ProducedArtifact] = field(default_factory=list)

    async def drive(self, step: ScenarioStep) -> StepRecord:
        index = len(self.driven)
        self.driven.append(step)
        if self.script is not None:
            return await self.script(step, index)
        return self.records[index] if index < len(self.records) else http_record()

    async def trace(self, trace_id: str) -> TargetTrace | None:
        return None

    async def health(self) -> HealthState:
        raise NotImplementedError

    async def close(self) -> None:
        self.closed += 1

    async def session_artifacts(self) -> Sequence[ProducedArtifact]:
        return self.session_files


@dataclass
class FakeOpener:
    adapter: FakeAdapter = field(default_factory=FakeAdapter)
    failure: Exception | None = None
    requests: list[AdapterOpenRequest] = field(default_factory=list)

    async def open(self, request: AdapterOpenRequest) -> OpenedAdapter:
        self.requests.append(request)
        if self.failure is not None:
            raise self.failure
        return OpenedAdapter(
            adapter=self.adapter,
            redact=lambda text: text.replace(SECRET, "${API_TOKEN}"),
            tier0_context=Tier0Context(internal_id_patterns=()),
        )


@dataclass
class RecordingHooks:
    halt_at: dict[int, Any] = field(default_factory=dict)
    assessments: dict[int, StepAssessment] = field(default_factory=dict)
    before: list[int] = field(default_factory=list)
    after: list[int] = field(default_factory=list)
    columns: dict[int, dict[str, Any]] = field(default_factory=dict)
    step_ids: list[UUID] = field(default_factory=list)
    inspect_step: Callable[[UUID], Awaitable[None]] | None = None

    async def before_step(self, context: StepContext) -> PreparedStep:
        self.before.append(context.index)
        return PreparedStep(
            step=context.step,
            halt=self.halt_at.get(context.index),
            step_columns=self.columns.get(context.index, {}),
        )

    async def after_step(
        self, context: StepContext, step_id: UUID, record: StepRecord, tier0: Tier0Result
    ) -> StepAssessment:
        self.after.append(context.index)
        self.step_ids.append(step_id)
        if self.inspect_step is not None:
            await self.inspect_step(step_id)
        return self.assessments.get(context.index, StepAssessment())


async def slow(seconds: float) -> None:
    await asyncio.sleep(seconds)


def write_file(directory: Path, name: str, content: bytes = b"data") -> Path:
    path = directory / name
    path.write_bytes(content)
    return path


def produced(path: Path, kind: ArtifactKind, mime: str) -> ProducedArtifact:
    return ProducedArtifact(kind=kind, mime=mime, path=path)
