import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Response
from pydantic import JsonValue
from sqlalchemy import update

from tessa_api.db.models import BrowserSessionRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.artifacts import StoredArtifact
from tessa_api.schemas.common import Viewport
from tessa_api.schemas.enums import AdapterKind, ArtifactKind, BrowserSessionStatus
from tessa_api.schemas.explore_actions import ExploreAction, ReadAction, TypeAction
from tessa_api.schemas.scenario import BrowserStep
from tessa_api.schemas.steps import BrowserStepResponse, StepResponseUnion
from tessa_api.schemas.streams import (
    BrowserSessionEndedPayload,
    BrowserSessionStartedPayload,
    IngestEvent,
    StepRecordedPayload,
)
from tessa_api.schemas.temporal import AgentGoal
from tessa_worker.activities.drive_ports import OpenedAdapter, Redact
from tessa_worker.adapters.base import ProducedArtifact, StepRecord
from tessa_worker.adapters.browser import BrowserAdapter
from tessa_worker.adapters.browser_session.actions import (
    EXPLORE_ACTION_KEY,
    ActionRejectedError,
    action_label,
    browser_steps_for,
    element_selector,
)
from tessa_worker.adapters.browser_session.snapshot import SnapshotStore, build_snapshot
from tessa_worker.adapters.browser_session.step_recorder import (
    RecordedStep,
    StepRecorder,
    merge_records,
)
from tessa_worker.checks.page_checks import dom_failures
from tessa_worker.event_client import build_event
from tessa_worker.lab.contracts import (
    ActionOutcome,
    Detector,
    FailedRequest,
    PageSnapshot,
)
from tessa_worker.lab.explore.detectors import build_detectors
from tessa_worker.lab.explore.guard import ExplorerGuard

logger = logging.getLogger("tessa_worker.browser_session")

SNAPSHOT_TIMEOUT_SECONDS = 15.0
SNAPSHOT_RETRY_PAUSE_SECONDS = 0.5
NETWORK_IDLE_WAIT_SECONDS = 3.0
FIELD_PROBE_TIMEOUT_SECONDS = 5.0
READ_TIMEOUT_SECONDS = 5.0
CLOSE_TIMEOUT_SECONDS = 30.0
READ_TEXT_CHARS = 20_000
SNAPSHOT_WINDOW = 2
SENSITIVE_AUTOCOMPLETE_PREFIXES = ("cc-", "current-password", "new-password", "one-time-code")
FIELD_PROBE_SCRIPT = (
    "(element) => ({"
    "type: (element.getAttribute('type') || '').toLowerCase(),"
    "complete: (element.getAttribute('autocomplete') || '').toLowerCase()"
    "})"
)


class SessionOpenError(Exception):
    def __init__(self, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.events: list[IngestEvent] = []


class SessionBrokenError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class SessionSpec:
    run_id: UUID
    run_scenario_id: UUID
    attempt: int
    goal: AgentGoal | None


@dataclass(frozen=True, slots=True)
class LoadedSession:
    target_id: UUID
    bundle_id: UUID
    role: str
    interface_id: str
    read_only: bool
    scenario_title: str
    allowed_origins: frozenset[str]
    login: tuple[BrowserStep, ...]


@dataclass(frozen=True, slots=True)
class SessionParts:
    spec: SessionSpec
    loaded: LoadedSession
    browser_session_id: UUID
    opened: OpenedAdapter
    adapter: BrowserAdapter
    recorder: StepRecorder
    snapshots: SnapshotStore
    session_factory: SessionFactory


def utc_now() -> datetime:
    return datetime.now(UTC)


def console_errors_of(response: StepResponseUnion | None) -> list[str]:
    if not isinstance(response, BrowserStepResponse):
        return []
    return [message.text for message in response.console if message.level == "error"]


EventSink = Callable[[Sequence[IngestEvent]], Awaitable[None]]


class ExplorerSession:
    def __init__(self, parts: SessionParts, sink: EventSink | None = None) -> None:
        self.parts = parts
        self.sink = sink
        self.browser_session_id = parts.browser_session_id
        self.run_scenario_id = parts.spec.run_scenario_id
        self.run_id = parts.spec.run_id
        self.attempt = parts.spec.attempt
        self.role = parts.loaded.role
        self.read_only = parts.loaded.read_only
        self.guard = ExplorerGuard(parts.loaded.allowed_origins, parts.loaded.read_only)
        self.detectors: list[Detector] = []
        self.current: PageSnapshot | None = None
        self.last_step_index = -1
        self.first_explore_index: int | None = None
        self.next_index = 0
        self.last_used = time.monotonic()
        self.closed = False
        self.pending_events: list[IngestEvent] = []
        self.failed_requests: list[FailedRequest] = []
        self.snapshot_refs: list[str] = []
        self.traces: list[StoredArtifact] = []
        parts.adapter.page.on("response", self.remember_response)

    @property
    def redact(self) -> Redact:
        return self.parts.opened.redact

    def touch(self) -> None:
        self.last_used = time.monotonic()

    def idle_seconds(self) -> float:
        return time.monotonic() - self.last_used

    def drain_events(self) -> list[IngestEvent]:
        drained, self.pending_events = self.pending_events, []
        return drained

    def remember_response(self, response: Response) -> None:
        if response.status >= 500:
            self.failed_requests.append(
                FailedRequest(response.request.method, response.url, response.status)
            )

    def require_current(self) -> PageSnapshot:
        if self.current is None:
            raise SessionBrokenError("the session has no snapshot yet")
        return self.current

    async def start(self) -> PageSnapshot:
        await self.register()
        await self.flush_events()
        await self.run_login()
        first = await self.snapshot()
        goal = self.parts.spec.goal
        if goal is not None:
            self.detectors = build_detectors(goal.kind, first.url)
        return first

    async def flush_events(self) -> None:
        if self.sink is not None and self.pending_events:
            await self.sink(self.drain_events())

    async def register(self) -> None:
        started_at = utc_now()
        viewport: Viewport = self.parts.adapter.viewport
        async with self.parts.session_factory() as session:
            session.add(
                BrowserSessionRow(
                    id=self.browser_session_id,
                    run_id=self.run_id,
                    run_scenario_id=self.run_scenario_id,
                    attempt=self.attempt,
                    status=BrowserSessionStatus.active,
                    viewport=viewport.model_dump(mode="json"),
                    started_at=started_at,
                )
            )
            await session.commit()
        self.pending_events.append(
            build_event(
                self.run_id,
                "browser_session.started",
                BrowserSessionStartedPayload(
                    browser_session_id=self.browser_session_id,
                    run_scenario_id=self.run_scenario_id,
                    attempt=self.attempt,
                    viewport=viewport,
                    scenario_title=self.parts.loaded.scenario_title,
                    started_at=started_at,
                ),
                f"browser_session.started:{self.browser_session_id}",
            )
        )

    async def run_login(self) -> None:
        steps = self.parts.loaded.login
        for position, step in enumerate(steps):
            record = await self.parts.adapter.drive(step)
            recorded = await self.record(record, {})
            await self.flush_events()
            if record.ok is False:
                raise SessionOpenError(
                    f"sign in step {recorded.index + 1} ({record.label}) failed: {record.error}"
                )
            if position == len(steps) - 1:
                self.check_signed_in(step, record.response)

    def check_signed_in(self, step: BrowserStep, response: StepResponseUnion | None) -> None:
        expectation = step.expect.dom_state
        if expectation is None or not isinstance(response, BrowserStepResponse):
            return
        failures = dom_failures(response, expectation)
        if failures:
            raise SessionOpenError(
                f"the sign in did not reach its expected page: {failures[0].message}"
            )

    async def record(
        self, record: StepRecord, request_extras: Mapping[str, JsonValue]
    ) -> RecordedStep:
        index = self.next_index
        self.next_index += 1
        recorded = await self.parts.recorder.persist(index, record, request_extras)
        self.last_step_index = index
        if self.first_explore_index is None and EXPLORE_ACTION_KEY in request_extras:
            self.first_explore_index = index
        if recorded.trace is not None:
            self.traces.append(recorded.trace)
        self.pending_events.append(
            build_event(
                self.run_id,
                "step.recorded",
                StepRecordedPayload(
                    step_id=recorded.step_id,
                    run_scenario_id=self.run_scenario_id,
                    attempt=self.attempt,
                    index=index,
                    adapter=AdapterKind.browser,
                    label=record.label,
                    ok=record.ok,
                    latency_ms=record.latency_ms,
                    cost_usd=record.cost_usd,
                    tier0_failure_count=0,
                    screenshot_count=recorded.screenshots,
                ),
                f"step.recorded:{self.run_scenario_id}:{self.attempt}:{index}",
            )
        )
        return recorded

    async def snapshot(self) -> PageSnapshot:
        self.touch()
        return await self.capture([], None)

    async def capture(self, console_errors: Sequence[str], read_text: str | None) -> PageSnapshot:
        page = self.parts.adapter.page
        aria, title = await self.observe_page()
        built = build_snapshot(
            page.url,
            title,
            aria,
            read_text,
            console_errors,
            list(self.failed_requests),
            self.redact,
        )
        stored = await self.parts.snapshots.save(built)
        self.failed_requests.clear()
        self.snapshot_refs.append(stored.ref)
        await self.drop_old_snapshots()
        self.current = stored
        return stored

    async def observe_page(self) -> tuple[str, str]:
        page = self.parts.adapter.page
        last_error: BaseException | None = None
        for attempt in range(2):
            try:
                async with asyncio.timeout(SNAPSHOT_TIMEOUT_SECONDS + 1):
                    aria = await page.aria_snapshot(timeout=SNAPSHOT_TIMEOUT_SECONDS * 1000)
                    title = await page.title()
            except (PlaywrightError, TimeoutError) as error:
                last_error = error
                if attempt == 0:
                    await asyncio.sleep(SNAPSHOT_RETRY_PAUSE_SECONDS)
                continue
            return aria, title
        raise SessionBrokenError("the page could not be observed") from last_error

    async def drop_old_snapshots(self) -> None:
        while len(self.snapshot_refs) > SNAPSHOT_WINDOW:
            await self.parts.snapshots.delete(self.snapshot_refs.pop(0))

    async def execute(self, action: ExploreAction) -> ActionOutcome:
        self.touch()
        before = self.require_current()
        steps = browser_steps_for(action, before.url)
        if isinstance(action, TypeAction):
            await self.reject_sensitive_field(action)
        self.failed_requests.clear()
        records: list[StepRecord] = []
        for step in steps:
            record = await self.parts.adapter.drive(step)
            records.append(record)
            if record.ok is False:
                break
        merged = merge_records(records, action_label(action)) if len(records) > 1 else records[0]
        recorded = await self.record(merged, {EXPLORE_ACTION_KEY: action.model_dump(mode="json")})
        read_text = await self.read_target_text(action) if merged.ok is not False else None
        await self.settle_network()
        after = await self.capture(console_errors_of(merged.response), read_text)
        return ActionOutcome(
            step_id=recorded.step_id,
            ok=merged.ok is not False,
            error=merged.error,
            before=before,
            after=after,
        )

    async def reject_sensitive_field(self, action: TypeAction) -> None:
        locator = self.parts.adapter.page.locator(element_selector(action.target))
        try:
            probe = await locator.evaluate(
                FIELD_PROBE_SCRIPT, timeout=FIELD_PROBE_TIMEOUT_SECONDS * 1000
            )
        except PlaywrightError:
            return
        kind = str(probe.get("type", ""))
        autocomplete = str(probe.get("complete", ""))
        if kind == "password" or autocomplete.startswith(SENSITIVE_AUTOCOMPLETE_PREFIXES):
            raise ActionRejectedError("password and other credential fields are never filled")

    async def read_target_text(self, action: ExploreAction) -> str | None:
        if not isinstance(action, ReadAction) or action.target is None:
            return None
        locator = self.parts.adapter.page.locator(element_selector(action.target))
        try:
            text = await locator.inner_text(timeout=READ_TIMEOUT_SECONDS * 1000)
        except PlaywrightError:
            return None
        return text[:READ_TEXT_CHARS]

    async def settle_network(self) -> None:
        with contextlib.suppress(PlaywrightError):
            await self.parts.adapter.page.wait_for_load_state(
                "networkidle", timeout=NETWORK_IDLE_WAIT_SECONDS * 1000
            )

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        produced: Sequence[ProducedArtifact] = ()
        try:
            async with asyncio.timeout(CLOSE_TIMEOUT_SECONDS):
                await self.parts.adapter.close()
                produced = await self.parts.adapter.session_artifacts()
        except Exception as error:
            logger.error(
                "browser_session_close_failed",
                extra={
                    "browser_session_id": str(self.browser_session_id),
                    "error_type": type(error).__name__,
                },
            )
        await self.end_session(produced)
        await self.delete_snapshots()

    async def end_session(self, produced: Sequence[ProducedArtifact]) -> None:
        try:
            stored = await self.parts.recorder.file_artifacts(produced)
            recording = next((item for item in stored if item.kind is ArtifactKind.recording), None)
            trace = self.traces[0] if self.traces else None
            ended_at = utc_now()
            async with self.parts.session_factory() as session:
                await session.execute(
                    update(BrowserSessionRow)
                    .where(BrowserSessionRow.id == self.browser_session_id)
                    .values(
                        status=BrowserSessionStatus.ended,
                        ended_at=ended_at,
                        recording=None if recording is None else recording.model_dump(mode="json"),
                        trace=None if trace is None else trace.model_dump(mode="json"),
                    )
                )
                await session.commit()
        except Exception as error:
            logger.error(
                "browser_session_end_not_recorded",
                extra={
                    "browser_session_id": str(self.browser_session_id),
                    "error_type": type(error).__name__,
                },
            )
            return
        self.pending_events.append(
            build_event(
                self.run_id,
                "browser_session.ended",
                BrowserSessionEndedPayload(
                    browser_session_id=self.browser_session_id,
                    run_scenario_id=self.run_scenario_id,
                    has_recording=recording is not None,
                    has_trace=trace is not None,
                    ended_at=ended_at,
                ),
                f"browser_session.ended:{self.browser_session_id}",
            )
        )

    async def delete_snapshots(self) -> None:
        refs, self.snapshot_refs = self.snapshot_refs, []
        for ref in refs:
            with contextlib.suppress(Exception):
                await self.parts.snapshots.delete(ref)
