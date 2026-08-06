from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field


class HelloRunCreate(BaseModel):
    ticks: int = Field(default=5, ge=1, le=60, description="number of hello.tick events")
    tick_interval_ms: int = Field(
        default=1000, ge=100, le=10000, description="pause between ticks in milliseconds"
    )
    include_laya: bool = Field(default=True, description="run the Laya smoke call")


class LayaSmokeInput(BaseModel):
    text: str


class LayaSmokeResult(BaseModel):
    ok: bool
    latency_ms: int
    status_code: int | None
    response_excerpt: str | None


class HelloWorkflowInput(BaseModel):
    run_id: UUID
    ticks: int
    tick_interval_ms: int
    include_laya: bool


class HelloWorkflowResult(BaseModel):
    ticks_emitted: int
    laya: LayaSmokeResult | None


class HelloWorkflowState(BaseModel):
    stage: Literal["starting", "ticking", "calling_laya", "finishing", "finished"]
    ticks_emitted: int
    ticks_total: int
    stop_requested: bool


class EmitRunEventInput(BaseModel):
    run_id: UUID | None
    type: str
    payload: dict[str, Any]
    dedupe_key: str | None
    ephemeral: bool = False


class EmitRunEventResult(BaseModel):
    seq: int | None
