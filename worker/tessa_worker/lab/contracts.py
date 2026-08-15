from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from tessa_api.schemas.enums import CandidateSource
from tessa_api.schemas.explore_actions import (
    ClickAction,
    ElementRef,
    ExploreAction,
    FinishAction,
    NavigateAction,
    ReadAction,
    SnapshotAssertion,
    TypeAction,
    explore_action_adapter,
)
from tessa_api.schemas.temporal import AgentGoal

__all__ = [
    "ActionGuard",
    "ActionOutcome",
    "CandidateDraft",
    "ClickAction",
    "DetectionContext",
    "Detector",
    "ElementRef",
    "ExploreAction",
    "FailedRequest",
    "FinishAction",
    "GuardVerdict",
    "NavigateAction",
    "PageSnapshot",
    "ReadAction",
    "SessionHandle",
    "SessionRegistry",
    "SnapshotAssertion",
    "TypeAction",
    "explore_action_adapter",
]


@dataclass(frozen=True, slots=True)
class FailedRequest:
    method: str
    url: str
    status: int


@dataclass(frozen=True, slots=True)
class PageSnapshot:
    ref: str
    url: str
    title: str
    text: str
    digest: str
    new_console_errors: tuple[str, ...]
    failed_requests: tuple[FailedRequest, ...]


@dataclass(frozen=True, slots=True)
class ActionOutcome:
    step_id: UUID
    ok: bool
    error: str | None
    before: PageSnapshot
    after: PageSnapshot


@dataclass(frozen=True, slots=True)
class GuardVerdict:
    allowed: bool
    reason: str | None


@dataclass(frozen=True, slots=True)
class DetectionContext:
    goal: AgentGoal
    index: int
    action: ExploreAction
    before: PageSnapshot
    after: PageSnapshot


@dataclass(frozen=True, slots=True)
class CandidateDraft:
    source: CandidateSource
    detector: str | None
    description: str
    from_index: int
    to_index: int
    assertion: SnapshotAssertion


class ActionGuard(Protocol):
    def check(self, action: ExploreAction, snapshot: PageSnapshot) -> GuardVerdict: ...


class Detector(Protocol):
    name: str

    def detect(self, context: DetectionContext) -> Sequence[CandidateDraft]: ...


class SessionHandle(Protocol):
    browser_session_id: UUID
    run_scenario_id: UUID

    async def snapshot(self) -> PageSnapshot: ...

    async def execute(self, action: ExploreAction) -> ActionOutcome: ...

    async def close(self) -> None: ...


class SessionRegistry(Protocol):
    def add(self, handle: SessionHandle) -> None: ...

    def get(self, browser_session_id: UUID) -> SessionHandle | None: ...

    def remove(self, browser_session_id: UUID) -> SessionHandle | None: ...

    def open_ids(self) -> frozenset[UUID]: ...
