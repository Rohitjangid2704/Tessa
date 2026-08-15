import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from tessa_api.schemas.explore_actions import (
    ExploreAction,
    SnapshotAssertion,
    explore_action_adapter,
)
from tessa_worker.adapters.browser_session.actions import (
    EXPLORE_ACTION_KEY,
    ActionRejectedError,
)
from tessa_worker.adapters.browser_session.session import ExplorerSession
from tessa_worker.lab.explore.assertions import assertion_holds

MAX_DETAIL_CHARS = 300


@dataclass(frozen=True, slots=True)
class RecordedAction:
    index: int
    label: str
    action: ExploreAction


@dataclass(frozen=True, slots=True)
class ReplayRun:
    reproduced: bool
    detail: str
    last_step_id: uuid.UUID | None
    last_step_index: int | None
    final_url: str | None


def action_of(request: Mapping[str, Any] | None) -> ExploreAction | None:
    if request is None or EXPLORE_ACTION_KEY not in request:
        return None
    try:
        return explore_action_adapter.validate_python(request[EXPLORE_ACTION_KEY])
    except ValidationError:
        return None


def recorded_actions(
    rows: Iterable[tuple[int, str, Mapping[str, Any] | None]], last_index: int
) -> list[RecordedAction]:
    recorded: list[RecordedAction] = []
    for index, label, request in sorted(rows, key=lambda row: row[0]):
        if index > last_index:
            break
        action = action_of(request)
        if action is not None:
            recorded.append(RecordedAction(index=index, label=label, action=action))
    return recorded


def failed_replay(
    detail: str, last_step_id: uuid.UUID | None, last_step_index: int | None
) -> ReplayRun:
    return ReplayRun(
        reproduced=False,
        detail=detail[:MAX_DETAIL_CHARS],
        last_step_id=last_step_id,
        last_step_index=last_step_index,
        final_url=None,
    )


async def replay_recorded(
    session: ExplorerSession, actions: Sequence[RecordedAction], assertion: SnapshotAssertion
) -> ReplayRun:
    snapshot = session.require_current()
    last_step_id: uuid.UUID | None = None
    last_step_index: int | None = None
    for recorded in actions:
        verdict = session.guard.check(recorded.action, snapshot)
        if not verdict.allowed:
            return failed_replay(
                f"step {recorded.index} was refused on replay: {verdict.reason}",
                last_step_id,
                last_step_index,
            )
        try:
            outcome = await session.execute(recorded.action)
        except ActionRejectedError as error:
            return failed_replay(
                f"step {recorded.index} was refused on replay: {error.reason}",
                last_step_id,
                last_step_index,
            )
        last_step_id, last_step_index = outcome.step_id, session.last_step_index
        if not outcome.ok:
            return failed_replay(
                f"step {recorded.index} did not complete on replay: {outcome.error}",
                last_step_id,
                last_step_index,
            )
        snapshot = outcome.after
    holds = assertion_holds(assertion, snapshot)
    return ReplayRun(
        reproduced=holds,
        detail="the typed check held on the replayed page"
        if holds
        else "the typed check did not hold on the replayed page",
        last_step_id=last_step_id,
        last_step_index=last_step_index,
        final_url=snapshot.url,
    )
