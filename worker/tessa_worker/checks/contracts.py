from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field

from tessa_api.schemas.scenario import (
    BrowserExpect,
    GraphqlExpect,
    HttpExpect,
    SseExpect,
    WebsocketExpect,
)
from tessa_api.schemas.steps import Tier0Result
from tessa_worker.adapters.base import StepRecord

StepExpectations = HttpExpect | SseExpect | BrowserExpect | WebsocketExpect | GraphqlExpect


class Tier0Context(BaseModel):
    model_config = ConfigDict(frozen=True)

    internal_id_patterns: tuple[str, ...] = Field(
        description="regular expressions that match an internal identifier: the bundle's "
        "invariants plus the default UUID and numeric id patterns"
    )


class Tier0Evaluator(Protocol):
    def __call__(
        self,
        step_record: StepRecord,
        expectations: StepExpectations,
        context: Tier0Context,
        /,
    ) -> Tier0Result: ...
