import asyncio
import contextlib
import logging
from collections.abc import Sequence
from uuid import UUID

from temporalio import activity

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import CandidateStatus
from tessa_api.schemas.explore_actions import ExploreAction, FinishAction
from tessa_api.schemas.streams import IngestEvent
from tessa_api.schemas.temporal import (
    CLOSE_BROWSER_SESSION_ACTIVITY,
    EXECUTE_ACTION_ACTIVITY,
    OPEN_BROWSER_SESSION_ACTIVITY,
    CloseBrowserSessionInput,
    CloseBrowserSessionResult,
    ExecuteActionInput,
    ExecuteActionResult,
    OpenBrowserSessionInput,
    OpenBrowserSessionResult,
)
from tessa_api.services.exploration_scenarios import exploration_scenario_key
from tessa_api.services.synthetic_scenarios import find_synthetic_run_scenario
from tessa_worker.activities.drive import heartbeating
from tessa_worker.adapters.browser_session.actions import ActionRejectedError
from tessa_worker.adapters.browser_session.opening import ExplorerSessions
from tessa_worker.adapters.browser_session.registry import InProcessSessionRegistry
from tessa_worker.adapters.browser_session.session import (
    ExplorerSession,
    SessionBrokenError,
    SessionOpenError,
    SessionSpec,
)
from tessa_worker.event_client import EventClient
from tessa_worker.lab.contracts import ActionOutcome, CandidateDraft, DetectionContext
from tessa_worker.lab.explore.assertions import assertion_holds
from tessa_worker.lab.explore.candidates import (
    CandidateView,
    candidate_event,
    claim_draft,
    insert_candidate,
)
from tessa_worker.lab.explore.errors import (
    ExploreErrorType,
    permanent_explore_error,
)

logger = logging.getLogger("tessa_worker.browser_session.activities")

HEARTBEAT_SECONDS = 2.0
REAPER_INTERVAL_SECONDS = 30.0
SESSION_IDLE_LIMIT_SECONDS = 600.0
ERROR_TEXT_CHARS = 300


def error_text(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"[:ERROR_TEXT_CHARS]


class BrowserSessionActivities:
    def __init__(
        self,
        session_factory: SessionFactory,
        events: EventClient,
        sessions: ExplorerSessions,
        registry: InProcessSessionRegistry | None = None,
        heartbeat_interval_seconds: float = HEARTBEAT_SECONDS,
        idle_limit_seconds: float = SESSION_IDLE_LIMIT_SECONDS,
    ) -> None:
        self.session_factory = session_factory
        self.events = events
        self.sessions = sessions
        self.registry = registry or InProcessSessionRegistry()
        self.heartbeat_interval_seconds = heartbeat_interval_seconds
        self.idle_limit_seconds = idle_limit_seconds
        self.reaper: asyncio.Task[None] | None = None

    @activity.defn(name=OPEN_BROWSER_SESSION_ACTIVITY)
    async def open_browser_session(
        self, request: OpenBrowserSessionInput
    ) -> OpenBrowserSessionResult:
        async with self.session_factory() as db:
            scenario = await find_synthetic_run_scenario(
                db, request.run_id, exploration_scenario_key(request.role)
            )
        if scenario is None:
            raise permanent_explore_error(
                ExploreErrorType.exploration_scenario_missing,
                f"run {request.run_id} has no exploration scenario for role {request.role}",
            )
        spec = SessionSpec(
            run_id=request.run_id,
            run_scenario_id=scenario.run_scenario_id,
            attempt=0,
            goal=request.goal,
        )
        async with heartbeating(self.heartbeat_interval_seconds, lambda: {"opening": 1}):
            session = await self.open_session(spec)
        self.registry.add(session)
        self.start_reaper()
        await self.events.deliver_all(session.drain_events())
        return OpenBrowserSessionResult(
            browser_session_id=session.browser_session_id,
            run_scenario_id=session.run_scenario_id,
            snapshot_ref=session.require_current().ref,
        )

    async def open_session(self, spec: SessionSpec) -> ExplorerSession:
        try:
            return await self.sessions.open(spec, self.events.deliver_all)
        except SessionOpenError as error:
            await self.events.deliver_all(error.events)
            raise permanent_explore_error(
                ExploreErrorType.session_open_failed, str(error)[:ERROR_TEXT_CHARS]
            ) from None
        except SessionBrokenError as error:
            raise permanent_explore_error(
                ExploreErrorType.session_broken, error_text(error)
            ) from None

    @activity.defn(name=CLOSE_BROWSER_SESSION_ACTIVITY)
    async def close_browser_session(
        self, request: CloseBrowserSessionInput
    ) -> CloseBrowserSessionResult:
        session = self.registry.remove(request.browser_session_id)
        if session is None:
            return CloseBrowserSessionResult(closed=False)
        was_open = not session.closed
        await session.close()
        await self.events.deliver_all(session.drain_events())
        return CloseBrowserSessionResult(closed=was_open)

    @activity.defn(name=EXECUTE_ACTION_ACTIVITY)
    async def execute_action(self, request: ExecuteActionInput) -> ExecuteActionResult:
        session = self.registry.get(request.browser_session_id)
        if session is None or session.closed:
            raise permanent_explore_error(
                ExploreErrorType.session_not_found,
                f"browser session {request.browser_session_id} is not open on this worker",
            )
        try:
            async with heartbeating(
                self.heartbeat_interval_seconds, lambda: {"step_index": session.last_step_index}
            ):
                result = await self.perform(session, request.action)
        except SessionBrokenError as error:
            raise permanent_explore_error(
                ExploreErrorType.session_broken, error_text(error)
            ) from None
        finally:
            await self.events.deliver_all(session.drain_events())
        return result

    async def perform(self, session: ExplorerSession, action: ExploreAction) -> ExecuteActionResult:
        current = session.require_current()
        if isinstance(action, FinishAction):
            return await self.finish(session, action)
        verdict = session.guard.check(action, current)
        if not verdict.allowed:
            return self.rejected(current.ref, current.digest, verdict.reason)
        try:
            outcome = await session.execute(action)
        except ActionRejectedError as error:
            return self.rejected(current.ref, current.digest, error.reason)
        candidates = await self.detect(session, action, outcome)
        return ExecuteActionResult(
            step_id=outcome.step_id,
            snapshot_ref=outcome.after.ref,
            snapshot_hash=outcome.after.digest,
            rejected_reason=None,
            candidate_ids=[candidate.id for candidate in candidates],
            step_index=session.last_step_index,
            page_url=outcome.after.url,
            failure=None if outcome.ok else (outcome.error or "the action did not complete"),
        )

    def rejected(self, ref: str, digest: str, reason: str | None) -> ExecuteActionResult:
        return ExecuteActionResult(
            step_id=None,
            snapshot_ref=ref,
            snapshot_hash=digest,
            rejected_reason=reason or "the action was refused",
            candidate_ids=[],
        )

    async def finish(self, session: ExplorerSession, action: FinishAction) -> ExecuteActionResult:
        current = session.require_current()
        last_index = max(session.last_step_index, 0)
        first_index = session.first_explore_index
        draft = claim_draft(action, last_index if first_index is None else first_index, last_index)
        candidate_ids: list[UUID] = []
        if draft is not None:
            holds = assertion_holds(draft.assertion, current)
            stored = await self.store_drafts(session, [draft], holds)
            candidate_ids = [candidate.id for candidate in stored] if holds else []
        return ExecuteActionResult(
            step_id=None,
            snapshot_ref=current.ref,
            snapshot_hash=current.digest,
            rejected_reason=None,
            candidate_ids=candidate_ids,
            page_url=current.url,
        )

    async def detect(
        self, session: ExplorerSession, action: ExploreAction, outcome: ActionOutcome
    ) -> list[CandidateView]:
        goal = session.parts.spec.goal
        if goal is None or not session.detectors:
            return []
        context = DetectionContext(
            goal=goal,
            index=session.last_step_index,
            action=action,
            before=outcome.before,
            after=outcome.after,
        )
        drafts = [
            draft
            for detector in session.detectors
            for draft in detector.detect(context)
            if assertion_holds(draft.assertion, outcome.after)
        ]
        return await self.store_drafts(session, drafts, True)

    async def store_drafts(
        self, session: ExplorerSession, drafts: Sequence[CandidateDraft], confirmed: bool
    ) -> list[CandidateView]:
        if not drafts:
            return []
        status = CandidateStatus.pending if confirmed else CandidateStatus.discarded
        async with self.session_factory() as db:
            stored = [
                await insert_candidate(db, session.run_id, session.run_scenario_id, draft, status)
                for draft in drafts
            ]
            await db.commit()
        if not confirmed:
            logger.info(
                "explore_claim_not_confirmed",
                extra={"run_id": str(session.run_id), "claims": len(stored)},
            )
            return stored
        events: list[IngestEvent] = [candidate_event(candidate) for candidate in stored]
        await self.events.deliver_all(events)
        return stored

    def start_reaper(self) -> None:
        if self.reaper is None or self.reaper.done():
            self.reaper = asyncio.create_task(self.reap_loop())

    async def reap_loop(self) -> None:
        while True:
            await asyncio.sleep(REAPER_INTERVAL_SECONDS)
            for session_id in self.registry.idle_ids(self.idle_limit_seconds):
                session = self.registry.remove(session_id)
                if session is None:
                    continue
                logger.warning(
                    "browser_session_reaped",
                    extra={"browser_session_id": str(session_id), "run_id": str(session.run_id)},
                )
                await self.close_quietly(session)

    async def close_quietly(self, session: ExplorerSession) -> None:
        try:
            await session.close()
            await self.events.deliver_all(session.drain_events())
        except Exception as error:
            logger.error(
                "browser_session_close_failed",
                extra={
                    "browser_session_id": str(session.browser_session_id),
                    "error_type": type(error).__name__,
                },
            )

    async def close_all(self) -> None:
        if self.reaper is not None:
            self.reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.reaper
            self.reaper = None
        for session_id in list(self.registry.open_ids()):
            session = self.registry.remove(session_id)
            if session is not None:
                await self.close_quietly(session)
