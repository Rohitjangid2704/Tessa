import asyncio
from collections import OrderedDict
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import select

from tessa_api.db.models import FindingRow, RunRow, ScenarioRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import FeedName, RunKind
from tessa_api.schemas.streams import (
    StreamClosingEvent,
    StreamClosingPayload,
    StreamHelloEvent,
    StreamHelloPayload,
)
from tessa_api.settings import Settings
from tessa_api.streams.coalescing import LatestEventCoalescer
from tessa_api.streams.guard import StreamGuard
from tessa_api.streams.hub import Hub, OutboundMessage, Subscription, Termination

SSE_MEDIA_TYPE = "text/event-stream"
SSE_HEADERS = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}
SSE_PING = ": ping\n\n"
RUN_CREATED = "run.created"
SCENARIO_CHANGED = "scenario.changed"
COVERAGE_UPDATED = "coverage.updated"
PROPOSAL_UPDATED = "proposal.updated"
AGENT_SESSION_CHANGED = "agent_session.changed"
PAYLOAD_TARGET_EVENT_TYPES = frozenset({COVERAGE_UPDATED, PROPOSAL_UPDATED, AGENT_SESSION_CHANGED})
FINDING_EVENT_TYPES = frozenset({"finding.created", "finding.updated", "finding.occurrence_added"})
DASHBOARD_INVALIDATE = "dashboard.invalidate"
DASHBOARD_INVALIDATE_MIN_INTERVAL_SECONDS = 2.0
TARGET_INDEPENDENT_EVENT_TYPES = frozenset({"notification.created", DASHBOARD_INVALIDATE})
RUN_DIRECTORY_CAPACITY = 4096

ClosingReason = Literal["max_age", "shutdown", "slow_consumer", "unauthorized"]


@dataclass(frozen=True, slots=True)
class FeedFilters:
    target_id: UUID | None = None
    kinds: frozenset[RunKind] = frozenset()
    run_id: UUID | None = None

    @property
    def needs_run_identity(self) -> bool:
        return self.target_id is not None or bool(self.kinds)


@dataclass(frozen=True, slots=True)
class RunIdentity:
    kind: RunKind | None
    target_id: UUID | None


def identity_from_created_payload(payload: dict[str, Any]) -> RunIdentity | None:
    try:
        kind = RunKind(payload["kind"])
        raw_target = payload.get("target_id")
        target_id = None if raw_target is None else UUID(str(raw_target))
    except (KeyError, ValueError):
        return None
    return RunIdentity(kind, target_id)


class RunDirectory:
    def __init__(
        self, session_factory: SessionFactory, capacity: int = RUN_DIRECTORY_CAPACITY
    ) -> None:
        self._session_factory = session_factory
        self._capacity = capacity
        self._identities: OrderedDict[UUID, RunIdentity] = OrderedDict()
        self._scenario_targets: OrderedDict[UUID, UUID] = OrderedDict()
        self._finding_targets: OrderedDict[UUID, UUID] = OrderedDict()
        self._lookups: set[asyncio.Future[Any]] = set()

    def __len__(self) -> int:
        return len(self._identities)

    def knows(self, run_id: UUID) -> bool:
        return run_id in self._identities

    def remember(self, run_id: UUID, identity: RunIdentity) -> None:
        self._identities[run_id] = identity
        self._identities.move_to_end(run_id)
        while len(self._identities) > self._capacity:
            self._identities.popitem(last=False)

    async def identify(self, message: OutboundMessage) -> RunIdentity | None:
        run_id = message.run_id
        if run_id is None:
            return None
        if message.type == RUN_CREATED and message.payload is not None:
            created = identity_from_created_payload(message.payload)
            if created is not None:
                self.remember(run_id, created)
                return created
        known = self._identities.get(run_id)
        if known is not None:
            self._identities.move_to_end(run_id)
            return known
        lookup = asyncio.ensure_future(self._load_identity(run_id))
        self._lookups.add(lookup)
        lookup.add_done_callback(self._lookups.discard)
        return await asyncio.shield(lookup)

    async def _load_identity(self, run_id: UUID) -> RunIdentity | None:
        async with self._session_factory() as session:
            row = (
                await session.execute(
                    select(RunRow.kind, RunRow.target_id).where(RunRow.id == run_id)
                )
            ).one_or_none()
        if row is None:
            return None
        identity = RunIdentity(row.kind, row.target_id)
        self.remember(run_id, identity)
        return identity

    async def scenario_target(self, scenario_id: UUID) -> UUID | None:
        known = self._scenario_targets.get(scenario_id)
        if known is not None:
            self._scenario_targets.move_to_end(scenario_id)
            return known
        lookup = asyncio.ensure_future(self._load_scenario_target(scenario_id))
        self._lookups.add(lookup)
        lookup.add_done_callback(self._lookups.discard)
        return await asyncio.shield(lookup)

    async def _load_scenario_target(self, scenario_id: UUID) -> UUID | None:
        async with self._session_factory() as session:
            target_id = await session.scalar(
                select(ScenarioRow.target_id).where(ScenarioRow.id == scenario_id)
            )
        if target_id is None:
            return None
        self._scenario_targets[scenario_id] = target_id
        while len(self._scenario_targets) > self._capacity:
            self._scenario_targets.popitem(last=False)
        return target_id

    async def finding_target(self, finding_id: UUID) -> UUID | None:
        known = self._finding_targets.get(finding_id)
        if known is not None:
            self._finding_targets.move_to_end(finding_id)
            return known
        lookup = asyncio.ensure_future(self._load_finding_target(finding_id))
        self._lookups.add(lookup)
        lookup.add_done_callback(self._lookups.discard)
        return await asyncio.shield(lookup)

    async def _load_finding_target(self, finding_id: UUID) -> UUID | None:
        async with self._session_factory() as session:
            target_id = await session.scalar(
                select(FindingRow.target_id).where(FindingRow.id == finding_id)
            )
        if target_id is None:
            return None
        self._finding_targets[finding_id] = target_id
        while len(self._finding_targets) > self._capacity:
            self._finding_targets.popitem(last=False)
        return target_id


def get_run_directory(request: Request) -> RunDirectory:
    directory: RunDirectory = request.app.state.run_directory
    return directory


RunDirectoryDep = Annotated[RunDirectory, Depends(get_run_directory)]


def parse_uuid(raw: Any) -> UUID | None:
    try:
        return UUID(str(raw))
    except ValueError:
        return None


async def message_target_id(
    message: OutboundMessage, identity: RunIdentity | None, directory: RunDirectory
) -> UUID | None:
    payload = message.payload or {}
    if message.type in PAYLOAD_TARGET_EVENT_TYPES:
        return parse_uuid(payload.get("target_id"))
    if message.type == SCENARIO_CHANGED:
        scenario_id = parse_uuid(payload.get("scenario_id"))
        return None if scenario_id is None else await directory.scenario_target(scenario_id)
    if message.type in FINDING_EVENT_TYPES:
        finding_id = parse_uuid(payload.get("finding_id"))
        return None if finding_id is None else await directory.finding_target(finding_id)
    return identity.target_id if identity is not None else None


async def feed_matches(
    message: OutboundMessage, filters: FeedFilters, directory: RunDirectory
) -> bool:
    if filters.run_id is not None and message.run_id != filters.run_id:
        return False
    if message.type in TARGET_INDEPENDENT_EVENT_TYPES:
        return True
    if not filters.needs_run_identity:
        return True
    identity = await directory.identify(message)
    if filters.kinds and (identity is None or identity.kind not in filters.kinds):
        return False
    if filters.target_id is not None:
        return await message_target_id(message, identity, directory) == filters.target_id
    return True


def sse_event(event_type: str, data: str) -> str:
    return f"event: {event_type}\ndata: {data}\n\n"


def hello_frame(feed: FeedName, heartbeat_seconds: int) -> str:
    event = StreamHelloEvent(
        type="stream.hello",
        run_id=None,
        seq=None,
        ts=datetime.now(UTC),
        payload=StreamHelloPayload(
            run_id=None,
            head_seq=None,
            resumed_from=None,
            heartbeat_seconds=heartbeat_seconds,
            limits=None,
            feed=feed,
        ),
    )
    return sse_event(event.type, event.model_dump_json())


def closing_frame(reason: ClosingReason) -> str:
    event = StreamClosingEvent(
        type="stream.closing",
        run_id=None,
        seq=None,
        ts=datetime.now(UTC),
        payload=StreamClosingPayload(reason=reason),
    )
    return sse_event(event.type, event.model_dump_json())


def earliest(*moments: float | None) -> float:
    return min(moment for moment in moments if moment is not None)


async def feed_stream(
    hub: Hub,
    settings: Settings,
    directory: RunDirectory,
    feed: FeedName,
    filters: FeedFilters,
    guard: StreamGuard | None = None,
) -> AsyncGenerator[str]:
    subscription = hub.subscribe_feed(feed, settings.ws_send_queue_max)
    try:
        yield hello_frame(feed, settings.stream_heartbeat_seconds)
        async for frame in feed_frames(subscription, settings, directory, filters, guard):
            yield frame
    finally:
        subscription.release()


async def feed_frames(
    subscription: Subscription,
    settings: Settings,
    directory: RunDirectory,
    filters: FeedFilters,
    guard: StreamGuard | None = None,
) -> AsyncIterator[str]:
    loop = asyncio.get_running_loop()
    heartbeat_seconds = settings.stream_heartbeat_seconds
    deadline = loop.time() + settings.stream_max_age_seconds
    next_ping = loop.time() + heartbeat_seconds
    invalidations = LatestEventCoalescer[OutboundMessage](DASHBOARD_INVALIDATE_MIN_INTERVAL_SECONDS)
    while True:
        now = loop.time()
        if now >= deadline:
            yield closing_frame("max_age")
            return
        held = invalidations.release(now)
        if held is not None:
            yield sse_event(held.type, held.text)
            continue
        wake_at = earliest(deadline, next_ping, invalidations.due_at())
        try:
            async with asyncio.timeout(wake_at - now):
                item = await subscription.queue.get()
        except TimeoutError:
            if loop.time() >= next_ping:
                if guard is not None and not await guard():
                    yield closing_frame("unauthorized")
                    return
                yield SSE_PING
                next_ping = loop.time() + heartbeat_seconds
            continue
        if isinstance(item, Termination):
            yield closing_frame(item.reason)
            return
        if not await feed_matches(item, filters, directory):
            continue
        if item.type != DASHBOARD_INVALIDATE:
            yield sse_event(item.type, item.text)
            continue
        immediate = invalidations.offer(item, loop.time())
        if immediate is not None:
            yield sse_event(immediate.type, immediate.text)
