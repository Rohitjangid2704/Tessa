from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, Field, JsonValue

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import AdapterKind, ArtifactKind
from tessa_api.schemas.health import HealthState
from tessa_api.schemas.scenario import ScenarioStep
from tessa_api.schemas.steps import StepRequestUnion, StepResponseUnion, StepTool

TargetTrace = dict[str, JsonValue]


@dataclass(frozen=True, slots=True)
class AdapterCapabilities:
    step_kinds: frozenset[str] = frozenset()
    needs_network: bool = True
    allowed_on_read_only: bool = True
    allowed_on_production: bool = True

    def drives(self, kind: AdapterKind, step_kind: str) -> bool:
        return step_kind == kind.value or step_kind in self.step_kinds


DEFAULT_CAPABILITIES = AdapterCapabilities()


class ProducedArtifact(BaseModel):
    kind: ArtifactKind
    mime: str = Field(description="media type of the file")
    path: Path = Field(description="local file the adapter wrote; the drive loop files it")


class StepRecord(BaseModel):
    adapter: AdapterKind
    label: str = Field(description="short description of the step")
    request: StepRequestUnion = Field(description="what was sent, secrets already redacted")
    response: StepResponseUnion | None = Field(
        description="what came back, secrets already redacted; None when nothing came back"
    )
    response_truncated: bool = Field(
        default=False, description="true when request or response was cut at the payload cap"
    )
    ok: bool | None = Field(
        description="true when the adapter completed the step; false when it failed to act "
        "(connection error, timeout, element not found); None when unknown"
    )
    error: str | None = Field(
        default=None, description="short redacted reason when ok is false; never a secret"
    )
    ask: str | None = Field(default=None, description="natural language input of a chat step")
    answer: str | None = Field(default=None, description="natural language answer of a chat step")
    tools: list[StepTool] = Field(default_factory=list)
    cards: list[dict[str, JsonValue]] = Field(default_factory=list)
    latency_ms: int = Field(ge=0, description="total step time in milliseconds")
    cost_usd: float = Field(default=0.0, ge=0, description="cost the system under test reported")
    artifacts: list[ProducedArtifact] = Field(default_factory=list)
    started_at: Timestamp
    finished_at: Timestamp


@runtime_checkable
class Adapter(Protocol):
    kind: AdapterKind

    async def drive(self, step: ScenarioStep) -> StepRecord: ...

    async def trace(self, trace_id: str) -> TargetTrace | None: ...

    async def health(self) -> HealthState: ...

    async def close(self) -> None: ...


@runtime_checkable
class ClockPinning(Protocol):
    async def pin_clock(self, at: datetime) -> None: ...


@runtime_checkable
class FlagSetting(Protocol):
    async def set_flags(self, flags: Mapping[str, bool]) -> None: ...


@runtime_checkable
class Resettable(Protocol):
    async def reset(self) -> None: ...
