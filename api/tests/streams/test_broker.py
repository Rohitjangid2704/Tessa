import uuid

from tessa_api.ids import new_id
from tessa_api.schemas.events import EventEnvelope
from tessa_api.streams.broker import FrameSource
from tessa_api.streams.hub import Hub, Subscription
from tessa_api.streams.tiles import ClientTiles, Demand
from tests.streams.support import OCCURRED_AT, new_hub
from tests.streams.tile_support import FakeClock, frame_payload, subscription

GRID = Demand(max_fps=4, quality=60, max_width=640)
FOCUS = Demand(max_fps=10, quality=75, max_width=1280)
IDLE = Demand(max_fps=0, quality=60, max_width=640)


def watch(hub: Hub, run_id: uuid.UUID) -> tuple[Subscription, ClientTiles]:
    watcher = hub.subscribe_run(run_id, new_id(), 100, 100)
    assert watcher is not None
    assert watcher.tiles is not None
    return watcher, watcher.tiles


def demands_of(source: FrameSource) -> dict[uuid.UUID, Demand]:
    return {
        message.payload.browser_session_id: Demand(
            message.payload.max_fps, message.payload.quality, message.payload.max_width
        )
        for message in source.take()
    }


def session_event(event_type: str, run_id: uuid.UUID, session_id: uuid.UUID) -> EventEnvelope:
    return EventEnvelope(
        type=event_type,
        run_id=run_id,
        seq=1,
        ts=OCCURRED_AT,
        payload={"browser_session_id": str(session_id)},
    )


def test_a_registered_session_with_nobody_watching_is_paused_for_a_new_worker_socket() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    hub.tiles.register_session(session_id, run_id)
    source = hub.tiles.attach_source()
    assert demands_of(source) == {session_id: IDLE}


def test_a_client_that_has_not_chosen_tiles_wants_the_session_as_grid() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    watch(hub, run_id)
    source = hub.tiles.attach_source()
    hub.tiles.register_session(session_id, run_id)
    assert demands_of(source) == {session_id: GRID}


def test_a_client_that_joins_later_makes_the_registered_sessions_wanted() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    hub.tiles.register_session(session_id, run_id)
    source = hub.tiles.attach_source()
    assert demands_of(source) == {session_id: IDLE}
    watch(hub, run_id)
    assert demands_of(source) == {session_id: GRID}


def test_when_a_wanted_session_ends_the_next_one_takes_its_place() -> None:
    hub = new_hub(live_max_tiles_per_client=1)
    run_id = new_id()
    first, second = new_id(), new_id()
    watch(hub, run_id)
    hub.tiles.register_session(first, run_id)
    hub.tiles.register_session(second, run_id)
    source = hub.tiles.attach_source()
    assert demands_of(source) == {first: GRID, second: IDLE}
    hub.tiles.unregister_session(first)
    assert demands_of(source) == {second: GRID}


def test_an_empty_subscription_stops_the_demand() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    _, tiles = watch(hub, run_id)
    source = hub.tiles.attach_source()
    hub.tiles.register_session(session_id, run_id)
    assert demands_of(source) == {session_id: GRID}
    hub.tiles.subscribe(run_id, tiles, [])
    assert demands_of(source) == {session_id: IDLE}


def test_demand_is_the_maximum_across_subscribers_and_returns_to_zero_when_all_leave() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    first, first_tiles = watch(hub, run_id)
    second, second_tiles = watch(hub, run_id)
    source = hub.tiles.attach_source()
    hub.tiles.register_session(session_id, run_id)
    hub.tiles.subscribe(run_id, first_tiles, [subscription(session_id, "grid")])
    assert demands_of(source)[session_id] == GRID
    hub.tiles.subscribe(run_id, second_tiles, [subscription(session_id, "focus")])
    assert demands_of(source)[session_id] == FOCUS
    second.release()
    assert demands_of(source)[session_id] == GRID
    first.release()
    assert demands_of(source)[session_id] == IDLE


def test_demand_is_only_sent_when_it_changes() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    _, first_tiles = watch(hub, run_id)
    _, second_tiles = watch(hub, run_id)
    source = hub.tiles.attach_source()
    hub.tiles.register_session(session_id, run_id)
    hub.tiles.subscribe(run_id, first_tiles, [subscription(session_id)])
    assert demands_of(source) == {session_id: GRID}
    hub.tiles.subscribe(run_id, second_tiles, [subscription(session_id)])
    assert demands_of(source) == {}


def test_a_slow_consumer_that_is_terminated_stops_counting_toward_demand() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    slow = hub.subscribe_run(run_id, new_id(), 1, 100)
    assert slow is not None
    assert slow.tiles is not None
    source = hub.tiles.attach_source()
    hub.tiles.register_session(session_id, run_id)
    hub.tiles.subscribe(run_id, slow.tiles, [subscription(session_id, "focus")])
    assert demands_of(source) == {session_id: FOCUS}
    for seq in (1, 2, 3):
        hub.publish_persisted(
            EventEnvelope(type="hello.tick", run_id=run_id, seq=seq, ts=OCCURRED_AT, payload={})
        )
    assert slow.termination is not None
    assert demands_of(source) == {session_id: IDLE}


def test_a_worker_socket_attached_later_learns_the_current_demand_of_every_session() -> None:
    hub = new_hub()
    run_id = new_id()
    watched, idle = new_id(), new_id()
    _, tiles = watch(hub, run_id)
    hub.tiles.register_session(watched, run_id)
    hub.tiles.register_session(idle, run_id)
    hub.tiles.subscribe(run_id, tiles, [subscription(watched, "focus")])
    source = hub.tiles.attach_source()
    assert demands_of(source) == {watched: FOCUS, idle: IDLE}


def test_every_attached_worker_socket_hears_the_changes() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    _, tiles = watch(hub, run_id)
    hub.tiles.subscribe(run_id, tiles, [])
    hub.tiles.register_session(session_id, run_id)
    first, second = hub.tiles.attach_source(), hub.tiles.attach_source()
    demands_of(first)
    demands_of(second)
    hub.tiles.subscribe(run_id, tiles, [subscription(session_id)])
    assert demands_of(first) == {session_id: GRID}
    assert demands_of(second) == {session_id: GRID}
    hub.tiles.detach_source(second)
    hub.tiles.subscribe(run_id, tiles, [])
    assert demands_of(first) == {session_id: IDLE}
    assert second.closed is True


def test_only_the_watchers_of_the_run_of_the_session_count_toward_its_demand() -> None:
    hub = new_hub()
    run_id, other_run = new_id(), new_id()
    session_id = new_id()
    _, outsider = watch(hub, other_run)
    source = hub.tiles.attach_source()
    hub.tiles.register_session(session_id, run_id)
    hub.tiles.subscribe(other_run, outsider, [subscription(session_id, "focus")])
    assert demands_of(source) == {}
    assert hub.tiles.demand_of(session_id) == IDLE


def test_frames_reach_only_the_subscribers_of_that_tile_in_that_run() -> None:
    hub = new_hub()
    run_id, other_run = new_id(), new_id()
    shown, hidden = new_id(), new_id()
    _, viewer = watch(hub, run_id)
    _, bystander = watch(hub, run_id)
    _, outsider = watch(hub, other_run)
    for session_id in (shown, hidden):
        hub.tiles.register_session(session_id, run_id)
    hub.tiles.subscribe(run_id, viewer, [subscription(shown)])
    hub.tiles.subscribe(run_id, bystander, [])
    hub.tiles.subscribe(other_run, outsider, [subscription(shown)])
    assert hub.tiles.publish_frame(frame_payload(shown, 1)) is True
    assert hub.tiles.publish_frame(frame_payload(hidden, 1)) is True
    assert [frame.session_id for frame in viewer.pop_ready()] == [shown]
    assert bystander.pop_ready() == []
    assert outsider.pop_ready() == []


def test_a_client_that_never_chose_gets_only_the_first_tiles_of_the_run() -> None:
    hub = new_hub(live_max_tiles_per_client=2)
    run_id = new_id()
    sessions = [new_id() for _ in range(3)]
    _, tiles = watch(hub, run_id)
    for session_id in sessions:
        hub.tiles.register_session(session_id, run_id)
    for session_id in sessions:
        hub.tiles.publish_frame(frame_payload(session_id, 1))
    assert {frame.session_id for frame in tiles.pop_ready()} == set(sessions[:2])


def test_a_frame_of_an_unknown_session_is_reported_back() -> None:
    hub = new_hub()
    assert hub.tiles.publish_frame(frame_payload(new_id(), 1)) is False


def test_frames_must_arrive_in_increasing_order() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    _, tiles = watch(hub, run_id)
    hub.tiles.register_session(session_id, run_id)
    hub.tiles.subscribe(run_id, tiles, [subscription(session_id)])
    hub.tiles.publish_frame(frame_payload(session_id, 5))
    hub.tiles.publish_frame(frame_payload(session_id, 4))
    hub.tiles.publish_frame(frame_payload(session_id, 5))
    channel = tiles.channel(session_id)
    assert channel is not None
    assert channel.offered == 1
    assert [frame.frame_seq for frame in tiles.pop_ready()] == [5]


def test_a_late_subscriber_gets_the_latest_frame_at_once() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    _, early = watch(hub, run_id)
    hub.tiles.register_session(session_id, run_id)
    hub.tiles.subscribe(run_id, early, [subscription(session_id)])
    hub.tiles.publish_frame(frame_payload(session_id, 1))
    hub.tiles.publish_frame(frame_payload(session_id, 2))
    _, late = watch(hub, run_id)
    hub.tiles.subscribe(run_id, late, [subscription(session_id)])
    assert [frame.frame_seq for frame in late.pop_ready()] == [2]


def test_a_subscriber_of_another_run_never_gets_the_latest_frame() -> None:
    hub = new_hub()
    run_id, other_run, session_id = new_id(), new_id(), new_id()
    hub.tiles.register_session(session_id, run_id)
    hub.tiles.publish_frame(frame_payload(session_id, 1))
    _, outsider = watch(hub, other_run)
    hub.tiles.subscribe(other_run, outsider, [subscription(session_id)])
    assert outsider.pop_ready() == []


def test_the_session_events_of_the_run_stream_open_and_close_sessions() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    hub.publish_persisted(session_event("browser_session.started", run_id, session_id))
    assert hub.tiles.run_of(session_id) == run_id
    assert hub.tiles.active_sessions(run_id) == [session_id]
    hub.publish_persisted(session_event("browser_session.ended", run_id, session_id))
    assert hub.tiles.run_of(session_id) is None
    assert hub.tiles.active_sessions(run_id) == []


def test_finishing_the_run_closes_its_sessions() -> None:
    hub = new_hub()
    run_id = new_id()
    sessions = [new_id(), new_id()]
    for session_id in sessions:
        hub.publish_persisted(session_event("browser_session.started", run_id, session_id))
    hub.publish_persisted(
        EventEnvelope(type="run.finished", run_id=run_id, seq=9, ts=OCCURRED_AT, payload={})
    )
    assert hub.tiles.active_sessions(run_id) == []


def test_a_session_event_without_a_usable_id_is_ignored() -> None:
    hub = new_hub()
    run_id = new_id()
    for payload in ({}, {"browser_session_id": "nope"}, {"browser_session_id": None}):
        hub.publish_persisted(
            EventEnvelope(
                type="browser_session.started",
                run_id=run_id,
                seq=1,
                ts=OCCURRED_AT,
                payload=payload,
            )
        )
    assert hub.tiles.active_sessions(run_id) == []


def test_registering_a_session_twice_keeps_one_entry_and_its_latest_frame() -> None:
    hub = new_hub()
    run_id, session_id = new_id(), new_id()
    hub.tiles.register_session(session_id, run_id)
    hub.tiles.publish_frame(frame_payload(session_id, 3))
    hub.tiles.register_session(session_id, run_id)
    _, tiles = watch(hub, run_id)
    hub.tiles.subscribe(run_id, tiles, [subscription(session_id)])
    assert [frame.frame_seq for frame in tiles.pop_ready()] == [3]
    assert hub.tiles.active_sessions(run_id) == [session_id]


def test_unknown_sessions_are_remembered_briefly() -> None:
    clock = FakeClock()
    hub = new_hub(clock)
    session_id = new_id()
    assert hub.tiles.recently_unknown(session_id) is False
    hub.tiles.remember_unknown(session_id)
    assert hub.tiles.recently_unknown(session_id) is True
    clock.advance(6.0)
    assert hub.tiles.recently_unknown(session_id) is False


def test_registering_a_session_clears_the_memory_of_it_being_unknown() -> None:
    hub = new_hub()
    session_id = new_id()
    hub.tiles.remember_unknown(session_id)
    hub.tiles.register_session(session_id, new_id())
    assert hub.tiles.recently_unknown(session_id) is False


def test_shutdown_closes_the_worker_sockets_and_stops_their_wake_up_wait() -> None:
    hub = new_hub()
    source = hub.tiles.attach_source()
    hub.shutdown()
    assert source.closed is True
    assert source.wake.is_set()
