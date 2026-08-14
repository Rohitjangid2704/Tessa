import asyncio
import logging
import uuid
from collections.abc import Mapping
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity

from tessa_api.db.models import RunRow, RunScenarioRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import (
    CandidateStatus,
    RunScenarioStatus,
    VerdictStatus,
    VerdictTier,
)
from tessa_api.schemas.streams import IngestEvent
from tessa_api.schemas.temporal import (
    VERIFY_BY_REPLAY_ACTIVITY,
    AgentGoal,
    DedupeMatch,
    FindingCandidate,
    UpsertDecision,
    VerifyByReplayInput,
    VerifyByReplayResult,
)
from tessa_api.services.exploration_scenarios import (
    verification_scenario_key,
    verification_scenario_request,
)
from tessa_api.services.findings.neighbours import exact_matches
from tessa_api.services.findings.repro import ReproUnavailableError, store_repro
from tessa_api.services.findings.upsert import upsert_decisions
from tessa_api.services.synthetic_scenarios import (
    SyntheticScenario,
    SyntheticScenarioInvalidError,
    create_synthetic_run_scenario,
    find_synthetic_run_scenario,
    queued_payload,
)
from tessa_worker.activities.drive import heartbeating
from tessa_worker.activities.run_models import (
    BeginScenarioAttemptInput,
    FinishRunScenarioInput,
    RecordScenarioAttemptInput,
)
from tessa_worker.activities.scenario_lifecycle import ScenarioLifecycleActivities
from tessa_worker.adapters.browser_session.opening import ExplorerSessions
from tessa_worker.adapters.browser_session.session import (
    ExplorerSession,
    SessionBrokenError,
    SessionOpenError,
    SessionSpec,
)
from tessa_worker.event_client import EventClient, build_event
from tessa_worker.findings.duplicates import exact_match, new_match
from tessa_worker.lab.explore.candidates import (
    CandidateView,
    lock_candidate,
    settle_candidate,
    verified_event,
    view_of,
)
from tessa_worker.lab.explore.errors import ExploreErrorType, permanent_explore_error
from tessa_worker.lab.explore.finding import VerifiedCandidate, build_finding_candidate
from tessa_worker.lab.explore.replay import (
    RecordedAction,
    ReplayRun,
    recorded_actions,
    replay_recorded,
)
from tessa_worker.settings import WorkerSettings
from tessa_worker.verdicts import (
    ATTEMPT_ERRORED,
    aggregate_attempt_verdicts,
    clip_reason,
    fail_verdict,
    uncertain_verdict,
)

logger = logging.getLogger("tessa_worker.verify")

HEARTBEAT_SECONDS = 2.0
REPRODUCED = "explore_reproduced"
NOT_REPRODUCED = "explore_not_reproduced"
SCENARIO_QUEUED_EVENT = "scenario.queued"
ERROR_TEXT_CHARS = 300


@dataclass(frozen=True, slots=True)
class VerificationContext:
    candidate: CandidateView
    target_id: uuid.UUID
    role: str
    interface_id: str
    actions: tuple[RecordedAction, ...]
    scenario: SyntheticScenario
    replays: int
    goal: AgentGoal | None


@dataclass(frozen=True, slots=True)
class AttemptOutcome:
    status: RunScenarioStatus
    verdict: Verdict
    reproduced: bool
    run: ReplayRun | None


def reproduced_verdict(detail: str) -> Verdict:
    return fail_verdict(detail, REPRODUCED)


def not_reproduced_verdict(detail: str) -> Verdict:
    return Verdict(
        status=VerdictStatus.pass_,
        tier=VerdictTier.code,
        confidence=1.0,
        reason_code=NOT_REPRODUCED,
        reason=clip_reason(detail),
        skip_reason=None,
    )


def outcome_of(run: ReplayRun) -> AttemptOutcome:
    verdict = (
        reproduced_verdict(run.detail) if run.reproduced else not_reproduced_verdict(run.detail)
    )
    return AttemptOutcome(RunScenarioStatus.finished, verdict, run.reproduced, run)


def errored_outcome(reason: str) -> AttemptOutcome:
    return AttemptOutcome(
        RunScenarioStatus.errored,
        uncertain_verdict(ATTEMPT_ERRORED, reason),
        False,
        None,
    )


def error_text(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"[:ERROR_TEXT_CHARS]


def match_for(candidate: FindingCandidate, known: Mapping[str, uuid.UUID]) -> DedupeMatch:
    existing = known.get(candidate.fingerprint)
    return new_match(candidate) if existing is None else exact_match(candidate, existing)


class VerifyActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        events: EventClient,
        sessions: ExplorerSessions,
        lifecycle: ScenarioLifecycleActivities,
        heartbeat_interval_seconds: float = HEARTBEAT_SECONDS,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events
        self.sessions = sessions
        self.lifecycle = lifecycle
        self.heartbeat_interval_seconds = heartbeat_interval_seconds

    @activity.defn(name=VERIFY_BY_REPLAY_ACTIVITY)
    async def verify_by_replay(self, request: VerifyByReplayInput) -> VerifyByReplayResult:
        progress = {"attempt": 0}
        async with heartbeating(self.heartbeat_interval_seconds, lambda: dict(progress)):
            prepared = await self.prepare(request)
            if isinstance(prepared, VerifyByReplayResult):
                return prepared
            return await self.verify(prepared, progress)

    async def prepare(
        self, request: VerifyByReplayInput
    ) -> VerificationContext | VerifyByReplayResult:
        events: list[IngestEvent] = []
        async with self.session_factory() as db:
            row = await lock_candidate(db, request.candidate_id)
            if row is None or row.run_id != request.run_id:
                raise permanent_explore_error(
                    ExploreErrorType.candidate_not_found,
                    f"candidate {request.candidate_id} does not belong to run {request.run_id}",
                )
            candidate = view_of(row)
            if candidate.status is not CandidateStatus.pending:
                return await self.recorded_result(db, candidate)
            run = await db.get(RunRow, request.run_id)
            main = await db.get(RunScenarioRow, candidate.run_scenario_id)
            if run is None or run.target_id is None or main is None:
                raise permanent_explore_error(
                    ExploreErrorType.run_not_found, f"run {request.run_id} lost its rows"
                )
            actions = await self.load_actions(db, candidate)
            replays = self.settings.verify_replays
            scenario_request = verification_scenario_request(
                run.id, candidate.id, main.role, main.interface_id, replays
            )
            try:
                scenario = await create_synthetic_run_scenario(db, scenario_request)
            except SyntheticScenarioInvalidError as error:
                raise permanent_explore_error(
                    ExploreErrorType.replay_scenario_invalid, str(error)
                ) from None
            if scenario.created:
                events.append(
                    build_event(
                        run.id,
                        SCENARIO_QUEUED_EVENT,
                        queued_payload(scenario_request, scenario),
                        f"{SCENARIO_QUEUED_EVENT}:{scenario.run_scenario_id}",
                    )
                )
            await db.commit()
        await self.events.deliver_all(events)
        return VerificationContext(
            candidate=candidate,
            target_id=run.target_id,
            role=main.role,
            interface_id=main.interface_id,
            actions=tuple(actions),
            scenario=scenario,
            replays=replays,
            goal=request.goal,
        )

    async def recorded_result(
        self, db: AsyncSession, candidate: CandidateView
    ) -> VerifyByReplayResult:
        scenario = await find_synthetic_run_scenario(
            db, candidate.run_id, verification_scenario_key(candidate.id)
        )
        return VerifyByReplayResult(
            verified=candidate.status is CandidateStatus.verified,
            run_scenario_id=None if scenario is None else scenario.run_scenario_id,
            finding_id=candidate.finding_id,
        )

    async def load_actions(
        self, db: AsyncSession, candidate: CandidateView
    ) -> list[RecordedAction]:
        rows = await db.execute(
            select(StepRow.index, StepRow.label, StepRow.request).where(
                StepRow.run_scenario_id == candidate.run_scenario_id, StepRow.attempt == 0
            )
        )
        return recorded_actions(
            [(index, label, request) for index, label, request in rows], candidate.to_index
        )

    async def verify(
        self, context: VerificationContext, progress: dict[str, int]
    ) -> VerifyByReplayResult:
        outcomes: list[AttemptOutcome] = []
        for attempt in range(context.replays):
            progress["attempt"] = attempt
            outcomes.append(await self.run_attempt(context, attempt))
        verdict = aggregate_attempt_verdicts([outcome.verdict for outcome in outcomes])
        await self.lifecycle.finish_run_scenario(
            FinishRunScenarioInput(
                run_scenario_id=context.scenario.run_scenario_id,
                status=RunScenarioStatus.finished,
                verdict=verdict,
            )
        )
        verified = all(outcome.reproduced for outcome in outcomes)
        finding_id = await self.settle(context, outcomes[-1], verified)
        return VerifyByReplayResult(
            verified=verified,
            run_scenario_id=context.scenario.run_scenario_id,
            finding_id=finding_id,
        )

    async def run_attempt(self, context: VerificationContext, attempt: int) -> AttemptOutcome:
        run_scenario_id = context.scenario.run_scenario_id
        await self.lifecycle.begin_scenario_attempt(
            BeginScenarioAttemptInput(run_scenario_id=run_scenario_id, attempt=attempt)
        )
        outcome = await self.replay_attempt(context, attempt)
        await self.lifecycle.record_scenario_attempt(
            RecordScenarioAttemptInput(
                run_scenario_id=run_scenario_id,
                attempt=attempt,
                status=outcome.status,
                verdict=outcome.verdict,
            )
        )
        return outcome

    async def replay_attempt(self, context: VerificationContext, attempt: int) -> AttemptOutcome:
        spec = SessionSpec(
            run_id=context.candidate.run_id,
            run_scenario_id=context.scenario.run_scenario_id,
            attempt=attempt,
            goal=None,
        )
        try:
            session = await self.sessions.open(spec, self.events.deliver_all)
        except SessionOpenError as error:
            await self.events.deliver_all(error.events)
            return errored_outcome(str(error)[:ERROR_TEXT_CHARS])
        except SessionBrokenError as error:
            return errored_outcome(error_text(error))
        try:
            return await self.replay_in(session, context)
        finally:
            await session.close()
            await self.events.deliver_all(session.drain_events())

    async def replay_in(
        self, session: ExplorerSession, context: VerificationContext
    ) -> AttemptOutcome:
        try:
            async with asyncio.timeout(self.settings.scenario_timeout_seconds):
                run = await replay_recorded(session, context.actions, context.candidate.assertion)
        except TimeoutError:
            return errored_outcome("the replay exceeded the scenario timeout")
        except SessionBrokenError as error:
            return errored_outcome(error_text(error))
        await self.events.deliver_all(session.drain_events())
        return outcome_of(run)

    async def settle(
        self, context: VerificationContext, last: AttemptOutcome, verified: bool
    ) -> uuid.UUID | None:
        candidate = context.candidate
        finding_id: uuid.UUID | None = None
        if verified and last.run is not None:
            finding_id = await self.file_finding(context, last.run)
        async with self.session_factory() as db:
            row = await lock_candidate(db, candidate.id)
            if row is not None:
                await settle_candidate(
                    db,
                    row,
                    CandidateStatus.verified if verified else CandidateStatus.unverified,
                    finding_id,
                )
            await db.commit()
        await self.events.deliver_all(
            [
                verified_event(
                    candidate.run_id,
                    candidate.id,
                    verified,
                    context.scenario.run_scenario_id,
                    finding_id,
                )
            ]
        )
        return finding_id

    async def file_finding(self, context: VerificationContext, run: ReplayRun) -> uuid.UUID | None:
        candidate = build_finding_candidate(
            VerifiedCandidate(
                candidate=context.candidate,
                target_id=context.target_id,
                role=context.role,
                interface_id=context.interface_id,
                scenario_id=context.scenario.scenario_id,
                run_scenario_id=context.scenario.run_scenario_id,
                attempt=context.replays - 1,
                step_id=run.last_step_id,
                final_url=run.final_url,
                replays=context.replays,
                goal=context.goal,
                path=tuple(action.label for action in context.actions),
            )
        )
        async with self.session_factory() as db:
            known = await exact_matches(db, context.target_id, [candidate.fingerprint])
            decision = UpsertDecision(candidate=candidate, match=match_for(candidate, known))
            outcome = await upsert_decisions(db, context.candidate.run_id, [decision])
            await db.commit()
        await self.events.deliver_all(list(outcome.events))
        touched = [*outcome.created_ids, *outcome.updated_ids]
        finding_id = touched[0] if touched else None
        for needs_repro in outcome.needs_repro:
            await self.build_repro(needs_repro)
        return finding_id

    async def build_repro(self, finding_id: uuid.UUID) -> None:
        async with self.session_factory() as db:
            try:
                await store_repro(db, finding_id)
            except ReproUnavailableError as error:
                logger.info("explore_repro_unavailable", extra={"reason": str(error)})
                return
            await db.commit()
