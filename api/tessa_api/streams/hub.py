import asyncio
import time
from collections import Counter
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from tessa_api.schemas.enums import FeedName
from tessa_api.schemas.events import EventEnvelope, feeds_for
from tessa_api.streams.broker import TileBroker
from tessa_api.streams.tiles import ClientTiles, Clock, TilePolicy

TerminationReason = Literal["slow_consumer", "shutdown"]


@dataclass(frozen=True, slots=True)
class OutboundMessage:
    type: str
    seq: int | None
    text: str
    run_id: UUID | None = None
    payload: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class Termination:
    reason: TerminationReason


QueueItem = OutboundMessage | Termination


def outbound_message(event: EventEnvelope) -> OutboundMessage:
    return OutboundMessage(
        event.type, event.seq, event.model_dump_json(), event.run_id, event.payload
    )


class Subscription:
    def __init__(
        self,
        hub: "Hub",
        queue_max: int,
        user_id: UUID | None,
        run_id: UUID | None,
        feed: FeedName | None,
        tiles: ClientTiles | None = None,
    ) -> None:
        self.run_id = run_id
        self.feed = feed
        self.user_id = user_id
        self.tiles = tiles
        self.queue: asyncio.Queue[QueueItem] = asyncio.Queue(maxsize=queue_max)
        self.termination: Termination | None = None
        self._hub = hub
        self._released = False

    def deliver(self, message: OutboundMessage) -> None:
        if self.termination is not None:
            return
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            self.terminate(Termination("slow_consumer"))

    def terminate(self, termination: Termination) -> None:
        if self.termination is not None:
            return
        self.termination = termination
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(termination)
        self._hub.detach(self)

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._hub.detach(self)
        if self.user_id is not None:
            self._hub.forget_connection(self.user_id)


@dataclass(slots=True)
class RunLockEntry:
    lock: asyncio.Lock
    holders: int = 0


class Hub:
    def __init__(self, tile_policy: TilePolicy, clock: Clock = time.monotonic) -> None:
        self._clock = clock
        self._run_subscriptions: dict[UUID, set[Subscription]] = {}
        self._feed_subscriptions: dict[FeedName, set[Subscription]] = {}
        self._user_connections: Counter[UUID] = Counter()
        self._run_locks: dict[UUID, RunLockEntry] = {}
        self.tiles = TileBroker(tile_policy, self._clients_of_run, clock)

    def subscribe_run(
        self, run_id: UUID, user_id: UUID, queue_max: int, max_connections_per_user: int
    ) -> Subscription | None:
        if self._user_connections[user_id] >= max_connections_per_user:
            return None
        client_tiles = ClientTiles(self.tiles.policy, self._clock)
        subscription = Subscription(self, queue_max, user_id, run_id, None, client_tiles)
        self._user_connections[user_id] += 1
        self._run_subscriptions.setdefault(run_id, set()).add(subscription)
        self.tiles.client_joined(run_id)
        return subscription

    def subscribe_feed(self, feed: FeedName, queue_max: int) -> Subscription:
        subscription = Subscription(self, queue_max, None, None, feed)
        self._feed_subscriptions.setdefault(feed, set()).add(subscription)
        return subscription

    def detach(self, subscription: Subscription) -> None:
        if subscription.run_id is not None:
            removed = self._discard(self._run_subscriptions, subscription.run_id, subscription)
            if removed and subscription.tiles is not None:
                self.tiles.client_left(subscription.run_id, subscription.tiles)
        if subscription.feed is not None:
            self._discard(self._feed_subscriptions, subscription.feed, subscription)

    def forget_connection(self, user_id: UUID) -> None:
        self._user_connections[user_id] -= 1
        if self._user_connections[user_id] <= 0:
            del self._user_connections[user_id]

    def connection_count(self, user_id: UUID) -> int:
        return self._user_connections[user_id]

    def run_subscriber_count(self, run_id: UUID) -> int:
        return len(self._run_subscriptions.get(run_id, ()))

    def feed_subscriber_count(self, feed: FeedName) -> int:
        return len(self._feed_subscriptions.get(feed, ()))

    def publish_persisted(self, event: EventEnvelope) -> None:
        message = outbound_message(event)
        if event.run_id is not None:
            self.tiles.observe_event(event)
            for subscription in tuple(self._run_subscriptions.get(event.run_id, ())):
                subscription.deliver(message)
        self._deliver_to_feeds(message)

    def publish_ephemeral(self, event: EventEnvelope) -> None:
        self._deliver_to_feeds(outbound_message(event))

    def shutdown(self) -> None:
        self.tiles.shutdown()
        every_subscription = [
            *(item for group in self._run_subscriptions.values() for item in group),
            *(item for group in self._feed_subscriptions.values() for item in group),
        ]
        for subscription in every_subscription:
            subscription.terminate(Termination("shutdown"))

    @asynccontextmanager
    async def run_locks(self, run_ids: Iterable[UUID]) -> AsyncIterator[None]:
        ordered = sorted(set(run_ids))
        entries = [self._claim_lock(run_id) for run_id in ordered]
        acquired: list[RunLockEntry] = []
        try:
            for entry in entries:
                await entry.lock.acquire()
                acquired.append(entry)
            yield
        finally:
            for entry in reversed(acquired):
                entry.lock.release()
            for run_id in ordered:
                self._drop_lock(run_id)

    def active_run_locks(self) -> int:
        return len(self._run_locks)

    def _deliver_to_feeds(self, message: OutboundMessage) -> None:
        for feed in feeds_for(message.type):
            for subscription in tuple(self._feed_subscriptions.get(feed, ())):
                subscription.deliver(message)

    def _clients_of_run(self, run_id: UUID) -> list[ClientTiles]:
        return [
            subscription.tiles
            for subscription in self._run_subscriptions.get(run_id, ())
            if subscription.tiles is not None
        ]

    def _claim_lock(self, run_id: UUID) -> RunLockEntry:
        entry = self._run_locks.get(run_id)
        if entry is None:
            entry = RunLockEntry(asyncio.Lock())
            self._run_locks[run_id] = entry
        entry.holders += 1
        return entry

    def _drop_lock(self, run_id: UUID) -> None:
        entry = self._run_locks[run_id]
        entry.holders -= 1
        if entry.holders == 0:
            del self._run_locks[run_id]

    @staticmethod
    def _discard[Key](
        registry: dict[Key, set[Subscription]], key: Key, subscription: Subscription
    ) -> bool:
        group = registry.get(key)
        if group is None or subscription not in group:
            return False
        group.discard(subscription)
        if not group:
            del registry[key]
        return True
