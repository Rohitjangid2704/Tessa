import asyncio
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from tessa_api.schemas.events import (
    EventEnvelope,
    TileDemandMessage,
    TileDemandPayload,
    TileFramePayload,
)
from tessa_api.schemas.streams import TileAckPayload, TileSubscription
from tessa_api.streams.tiles import (
    ClientTiles,
    Clock,
    Demand,
    TileFrame,
    TileMode,
    TilePolicy,
)

UNKNOWN_SESSION_MEMORY_SECONDS = 5.0
UNKNOWN_SESSION_MEMORY_LIMIT = 1024
BROWSER_SESSION_STARTED = "browser_session.started"
BROWSER_SESSION_ENDED = "browser_session.ended"
RUN_FINISHED = "run.finished"

ClientsOfRun = Callable[[UUID], Iterable[ClientTiles]]


def session_id_of(payload: dict[str, Any]) -> UUID | None:
    try:
        return UUID(str(payload["browser_session_id"]))
    except (KeyError, ValueError):
        return None


@dataclass(slots=True)
class SessionTile:
    run_id: UUID
    demand: Demand
    latest: TileFrame | None = None
    highest_seq: int = -1


class FrameSource:
    def __init__(self) -> None:
        self._pending: dict[UUID, Demand] = {}
        self.wake = asyncio.Event()
        self.closed = False

    def push(self, session_id: UUID, demand: Demand) -> None:
        self._pending[session_id] = demand
        self.wake.set()

    def close(self) -> None:
        self.closed = True
        self.wake.set()

    def take(self) -> list[TileDemandMessage]:
        self.wake.clear()
        taken = self._pending
        self._pending = {}
        return [demand_message(session_id, demand) for session_id, demand in taken.items()]


def demand_message(session_id: UUID, demand: Demand) -> TileDemandMessage:
    return TileDemandMessage(
        type="tile.demand",
        payload=TileDemandPayload(
            browser_session_id=session_id,
            max_fps=demand.max_fps,
            quality=demand.quality,
            max_width=demand.max_width,
        ),
    )


class TileBroker:
    def __init__(
        self, policy: TilePolicy, clients_of: ClientsOfRun, clock: Clock = time.monotonic
    ) -> None:
        self.policy = policy
        self._clients_of = clients_of
        self._clock = clock
        self._sessions: dict[UUID, SessionTile] = {}
        self._run_sessions: dict[UUID, dict[UUID, None]] = {}
        self._sources: set[FrameSource] = set()
        self._unknown_until: dict[UUID, float] = {}

    def observe_event(self, event: EventEnvelope) -> None:
        if event.run_id is None:
            return
        if event.type == BROWSER_SESSION_STARTED:
            session_id = session_id_of(event.payload)
            if session_id is not None:
                self.register_session(session_id, event.run_id)
        elif event.type == BROWSER_SESSION_ENDED:
            session_id = session_id_of(event.payload)
            if session_id is not None:
                self.unregister_session(session_id)
        elif event.type == RUN_FINISHED:
            self.unregister_run(event.run_id)

    def register_session(self, session_id: UUID, run_id: UUID) -> None:
        existing = self._sessions.get(session_id)
        if existing is not None and existing.run_id == run_id:
            return
        self._sessions[session_id] = SessionTile(run_id, self.policy.idle_demand())
        self._run_sessions.setdefault(run_id, {})[session_id] = None
        self._unknown_until.pop(session_id, None)
        self.refresh_demand({session_id})

    def unregister_session(self, session_id: UUID) -> None:
        session = self._sessions.pop(session_id, None)
        if session is None:
            return
        run_sessions = self._run_sessions.get(session.run_id)
        if run_sessions is not None:
            run_sessions.pop(session_id, None)
            if not run_sessions:
                del self._run_sessions[session.run_id]
        self.refresh_demand(self._first_tiles(session.run_id))

    def client_joined(self, run_id: UUID) -> None:
        self.refresh_demand(self._first_tiles(run_id))

    def _first_tiles(self, run_id: UUID) -> list[UUID]:
        return list(self._run_sessions.get(run_id, ()))[: self.policy.max_tiles]

    def unregister_run(self, run_id: UUID) -> None:
        for session_id in tuple(self._run_sessions.get(run_id, ())):
            self.unregister_session(session_id)

    def is_registered(self, session_id: UUID) -> bool:
        return session_id in self._sessions

    def run_of(self, session_id: UUID) -> UUID | None:
        session = self._sessions.get(session_id)
        return None if session is None else session.run_id

    def active_sessions(self, run_id: UUID) -> list[UUID]:
        return list(self._run_sessions.get(run_id, ()))

    def demand_of(self, session_id: UUID) -> Demand | None:
        session = self._sessions.get(session_id)
        return None if session is None else session.demand

    def remember_unknown(self, session_id: UUID) -> None:
        if len(self._unknown_until) >= UNKNOWN_SESSION_MEMORY_LIMIT:
            self._unknown_until.clear()
        self._unknown_until[session_id] = self._clock() + UNKNOWN_SESSION_MEMORY_SECONDS

    def recently_unknown(self, session_id: UUID) -> bool:
        until = self._unknown_until.get(session_id)
        if until is None:
            return False
        if self._clock() >= until:
            del self._unknown_until[session_id]
            return False
        return True

    def attach_source(self) -> FrameSource:
        source = FrameSource()
        for session_id, session in self._sessions.items():
            source.push(session_id, session.demand)
        self._sources.add(source)
        return source

    def detach_source(self, source: FrameSource) -> None:
        self._sources.discard(source)
        source.close()

    def publish_frame(self, payload: TileFramePayload) -> bool:
        session = self._sessions.get(payload.browser_session_id)
        if session is None:
            return False
        if payload.frame_seq <= session.highest_seq:
            return True
        session.highest_seq = payload.frame_seq
        frame = TileFrame(session.run_id, payload)
        session.latest = frame
        for client in self._clients_of(session.run_id):
            mode = self.mode_for(client, session.run_id, payload.browser_session_id)
            if mode is not None:
                client.offer(frame, mode)
        return True

    def subscribe(self, run_id: UUID, client: ClientTiles, tiles: list[TileSubscription]) -> None:
        was_explicit = client.explicit
        affected = client.replace_subscription(tiles)
        if not was_explicit:
            affected.update(self._run_sessions.get(run_id, ()))
        for tile in tiles:
            session = self._sessions.get(tile.browser_session_id)
            if session is not None and session.run_id == run_id and session.latest is not None:
                client.offer(session.latest, tile.mode)
        self.refresh_demand(affected)

    def acknowledge(self, client: ClientTiles, payload: TileAckPayload) -> None:
        client.acknowledge(payload.browser_session_id, payload.frame_seq)

    def client_left(self, run_id: UUID, client: ClientTiles) -> None:
        wanted = client.subscribed_ids()
        if not client.explicit:
            wanted.update(self._run_sessions.get(run_id, ()))
        self.refresh_demand(wanted)

    def mode_for(self, client: ClientTiles, run_id: UUID, session_id: UUID) -> TileMode | None:
        if client.explicit:
            return client.mode_of(session_id)
        return "grid" if session_id in self._first_tiles(run_id) else None

    def refresh_demand(self, session_ids: Iterable[UUID]) -> None:
        for session_id in session_ids:
            session = self._sessions.get(session_id)
            if session is None:
                continue
            modes = [
                mode
                for client in self._clients_of(session.run_id)
                if (mode := self.mode_for(client, session.run_id, session_id)) is not None
            ]
            demand = self.policy.demand_for(modes)
            if demand == session.demand:
                continue
            session.demand = demand
            for source in self._sources:
                source.push(session_id, demand)

    def shutdown(self) -> None:
        for source in tuple(self._sources):
            self.detach_source(source)
