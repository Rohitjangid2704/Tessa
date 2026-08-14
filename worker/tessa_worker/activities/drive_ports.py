from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable
from uuid import UUID

from pydantic import JsonValue

from tessa_api.schemas.common import Verdict, Viewport
from tessa_api.schemas.enums import SkipReason
from tessa_api.schemas.scenario import ScenarioDoc, ScenarioStep
from tessa_api.schemas.steps import Tier0Failure, Tier0Result
from tessa_worker.adapters.base import Adapter, ProducedArtifact, StepRecord
from tessa_worker.checks.contracts import Tier0Context

Redact = Callable[[str], str]


class AdapterOpenError(Exception):
    def __init__(self, message: str, skip_reason: SkipReason | None = None) -> None:
        super().__init__(message)
        self.skip_reason = skip_reason


@dataclass(frozen=True, slots=True)
class AdapterOpenRequest:
    target_id: UUID
    bundle_id: UUID
    role: str
    interface_id: str
    run_id: UUID
    run_scenario_id: UUID
    attempt: int
    read_only: bool
    step_timeout_seconds: float
    browser_session_id: UUID


@dataclass(frozen=True, slots=True)
class OpenedAdapter:
    adapter: Adapter
    redact: Redact
    tier0_context: Tier0Context


class AdapterOpener(Protocol):
    async def open(self, request: AdapterOpenRequest) -> OpenedAdapter: ...


@runtime_checkable
class LiveSessionAdapter(Protocol):
    viewport: Viewport

    async def session_artifacts(self) -> Sequence[ProducedArtifact]: ...


@dataclass(frozen=True, slots=True)
class StepContext:
    run_id: UUID
    run_scenario_id: UUID
    attempt: int
    index: int
    read_only: bool
    scenario: ScenarioDoc
    step: ScenarioStep


@dataclass(frozen=True, slots=True)
class PreparedStep:
    step: ScenarioStep
    halt: Verdict | None = None
    step_columns: Mapping[str, JsonValue] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class StepAssessment:
    verdict: Verdict | None = None
    failures: tuple[Tier0Failure, ...] = ()
    step_columns: Mapping[str, JsonValue] = field(default_factory=dict)


class StepHooks(Protocol):
    async def before_step(self, context: StepContext) -> PreparedStep: ...

    async def after_step(
        self, context: StepContext, step_id: UUID, record: StepRecord, tier0: Tier0Result
    ) -> StepAssessment: ...


class NoStepHooks:
    async def before_step(self, context: StepContext) -> PreparedStep:
        return PreparedStep(step=context.step)

    async def after_step(
        self, context: StepContext, step_id: UUID, record: StepRecord, tier0: Tier0Result
    ) -> StepAssessment:
        return StepAssessment()
