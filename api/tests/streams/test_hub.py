import asyncio
import uuid

from tessa_api.ids import new_id
from tessa_api.schemas.enums import FeedName
from tessa_api.schemas.events import EventEnvelope, feeds_for
from tessa_api.streams.hub import OutboundMessage, Subscription, Termination
from tests.streams.support import OCCURRED_AT, new_hub


def envelope(
    event_type: str = "hello.tick", run_id: uuid.UUID | None = None, seq: int | None = 1
) -> EventEnvelope:
    return EventEnvelope(type=event_type, run_id=run_id, seq=seq, ts=OCCURRED_AT, payload={})


def drain(subscription: Subscription) -> list[OutboundMessage | Termination]:
    items: list[OutboundMessage | Termination] = []
    while not subscription.queue.empty():
        items.append(subscription.queue.get_nowait())
    return items


def test_persisted_events_reach_only_subscribers_of_that_run() -> None:
    hub = new_hub()
    first, second = new_id(), new_id()
    on_first = hub.subscribe_run(first, new_id(), 10, 5)
    on_second = hub.subscribe_run(second, new_id(), 10, 5)
    assert on_first is not None
    assert on_second is not None
    hub.publish_persisted(envelope(run_id=first, seq=1))
    hub.publish_persisted(envelope(run_id=first, seq=2))
    assert [item.seq for item in drain(on_first) if isinstance(item, OutboundMessage)] == [1, 2]
    assert drain(on_second) == []


def test_every_subscriber_of_a_run_gets_its_own_copy() -> None:
    hub = new_hub()
    run_id = new_id()
    subscriptions = [hub.subscribe_run(run_id, new_id(), 10, 5) for _ in range(3)]
    hub.publish_persisted(envelope(run_id=run_id, seq=1))
    for subscription in subscriptions:
        assert subscription is not None
        assert subscription.queue.qsize() == 1


def test_persisted_events_also_reach_the_catalog_feeds() -> None:
    hub = new_hub()
    run_id = new_id()
    runs = hub.subscribe_feed(FeedName.runs, 10)
    home = hub.subscribe_feed(FeedName.home, 10)
    findings = hub.subscribe_feed(FeedName.findings, 10)
    hub.publish_persisted(envelope("run.created", run_id, 1))
    hub.publish_persisted(envelope("hello.tick", run_id, 2))
    assert runs.queue.qsize() == 1
    assert home.queue.qsize() == 1
    assert findings.queue.qsize() == 0


def test_ephemeral_events_go_to_feeds_only() -> None:
    hub = new_hub()
    run_id = new_id()
    run_stream = hub.subscribe_run(run_id, new_id(), 10, 5)
    findings = hub.subscribe_feed(FeedName.findings, 10)
    hub.publish_ephemeral(envelope("finding.occurrence_added", run_id, None))
    assert run_stream is not None
    assert run_stream.queue.qsize() == 0
    assert findings.queue.qsize() == 1


def test_event_without_a_run_reaches_feeds_but_no_run_stream() -> None:
    hub = new_hub()
    home = hub.subscribe_feed(FeedName.home, 10)
    hub.publish_persisted(envelope("run.created", None, None))
    assert home.queue.qsize() == 1


def test_feed_routing_follows_the_event_catalog() -> None:
    assert feeds_for("run.finished") == (FeedName.runs, FeedName.home)
    assert feeds_for("finding.created") == (FeedName.findings, FeedName.home)
    assert feeds_for("coverage.updated") == (FeedName.coverage,)
    assert feeds_for("hello.tick") == ()
    assert feeds_for("stream.hello") == ()
    assert feeds_for("something.new") == ()


def test_per_user_connection_cap_and_release() -> None:
    hub = new_hub()
    user, other, run_id = new_id(), new_id(), new_id()
    first = hub.subscribe_run(run_id, user, 10, 2)
    second = hub.subscribe_run(run_id, user, 10, 2)
    assert first is not None
    assert second is not None
    assert hub.subscribe_run(run_id, user, 10, 2) is None
    assert hub.subscribe_run(run_id, other, 10, 2) is not None
    assert hub.connection_count(user) == 2
    first.release()
    assert hub.connection_count(user) == 1
    assert hub.subscribe_run(run_id, user, 10, 2) is not None


def test_release_is_idempotent_and_stops_delivery() -> None:
    hub = new_hub()
    user, run_id = new_id(), new_id()
    subscription = hub.subscribe_run(run_id, user, 10, 5)
    assert subscription is not None
    subscription.release()
    subscription.release()
    assert hub.connection_count(user) == 0
    assert hub.run_subscriber_count(run_id) == 0
    hub.publish_persisted(envelope(run_id=run_id))
    assert subscription.queue.empty()


def test_overflow_drops_the_backlog_and_leaves_only_the_termination() -> None:
    hub = new_hub()
    user, run_id = new_id(), new_id()
    subscription = hub.subscribe_run(run_id, user, 2, 5)
    assert subscription is not None
    for seq in (1, 2, 3):
        hub.publish_persisted(envelope(run_id=run_id, seq=seq))
    assert subscription.termination == Termination("slow_consumer")
    assert drain(subscription) == [Termination("slow_consumer")]
    assert hub.run_subscriber_count(run_id) == 0
    assert hub.connection_count(user) == 1
    hub.publish_persisted(envelope(run_id=run_id, seq=4))
    assert subscription.queue.empty()
    subscription.release()
    assert hub.connection_count(user) == 0


def test_overflow_of_one_subscriber_does_not_touch_the_others() -> None:
    hub = new_hub()
    run_id = new_id()
    slow = hub.subscribe_run(run_id, new_id(), 1, 5)
    fast = hub.subscribe_run(run_id, new_id(), 10, 5)
    assert slow is not None
    assert fast is not None
    for seq in (1, 2, 3):
        hub.publish_persisted(envelope(run_id=run_id, seq=seq))
    assert slow.termination is not None
    assert fast.termination is None
    assert fast.queue.qsize() == 3


def test_shutdown_terminates_run_and_feed_subscribers() -> None:
    hub = new_hub()
    run_stream = hub.subscribe_run(new_id(), new_id(), 10, 5)
    feed = hub.subscribe_feed(FeedName.runs, 10)
    hub.shutdown()
    assert run_stream is not None
    assert drain(run_stream) == [Termination("shutdown")]
    assert drain(feed) == [Termination("shutdown")]


async def test_run_lock_serialises_the_same_run_and_cleans_up() -> None:
    hub = new_hub()
    run_id = new_id()
    inside = 0
    peak = 0

    async def critical() -> None:
        nonlocal inside, peak
        async with hub.run_locks([run_id]):
            inside += 1
            peak = max(peak, inside)
            await asyncio.sleep(0.01)
            inside -= 1

    await asyncio.gather(*(critical() for _ in range(10)))
    assert peak == 1
    assert hub.active_run_locks() == 0


async def test_run_locks_of_different_runs_do_not_block_each_other() -> None:
    hub = new_hub()
    first, second = new_id(), new_id()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def holder() -> None:
        async with hub.run_locks([first]):
            entered.set()
            await release.wait()

    task = asyncio.create_task(holder())
    await entered.wait()
    async with asyncio.timeout(1):
        async with hub.run_locks([second]):
            pass
    release.set()
    await task


async def test_overlapping_multi_run_locks_cannot_deadlock() -> None:
    hub = new_hub()
    first, second = new_id(), new_id()

    async def take(order: list[uuid.UUID]) -> None:
        for _ in range(50):
            async with hub.run_locks(order):
                await asyncio.sleep(0)

    async with asyncio.timeout(5):
        await asyncio.gather(take([first, second]), take([second, first]))
    assert hub.active_run_locks() == 0


async def test_cancelled_waiter_releases_its_claim() -> None:
    hub = new_hub()
    run_id = new_id()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def holder() -> None:
        async with hub.run_locks([run_id]):
            entered.set()
            await release.wait()

    async def waiter() -> None:
        async with hub.run_locks([run_id]):
            pass

    holding = asyncio.create_task(holder())
    await entered.wait()
    waiting = asyncio.create_task(waiter())
    await asyncio.sleep(0.01)
    waiting.cancel()
    await asyncio.gather(waiting, return_exceptions=True)
    release.set()
    await holding
    assert hub.active_run_locks() == 0
