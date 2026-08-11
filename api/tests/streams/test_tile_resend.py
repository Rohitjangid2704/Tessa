from tessa_api.ids import new_id
from tessa_api.streams.tiles import ClientTiles
from tests.streams.support import new_hub
from tests.streams.tile_support import FakeClock, frame_payload, make_frame, subscription


def test_choosing_tiles_after_a_frame_was_sent_never_sends_that_frame_again() -> None:
    clock = FakeClock()
    hub = new_hub(clock)
    run_id, session_id = new_id(), new_id()
    watcher = hub.subscribe_run(run_id, new_id(), 100, 100)
    assert watcher is not None
    assert watcher.tiles is not None
    tiles = watcher.tiles
    hub.tiles.register_session(session_id, run_id)
    hub.tiles.publish_frame(frame_payload(session_id, 0))
    assert [frame.frame_seq for frame in tiles.pop_ready()] == [0]
    tiles.acknowledge(session_id, 0)
    clock.advance(1)
    hub.tiles.subscribe(run_id, tiles, [subscription(session_id)])
    assert tiles.pop_ready() == []
    hub.tiles.publish_frame(frame_payload(session_id, 1))
    assert [frame.frame_seq for frame in tiles.pop_ready()] == [1]


def test_a_channel_refuses_a_frame_older_than_the_one_it_holds_or_sent() -> None:
    clock = FakeClock()
    tiles = ClientTiles(new_hub().tiles.policy, clock)
    session_id = new_id()
    tiles.replace_subscription([subscription(session_id)])
    assert tiles.offer(make_frame(session_id, 3), "grid") is True
    assert tiles.offer(make_frame(session_id, 2), "grid") is False
    assert [frame.frame_seq for frame in tiles.pop_ready()] == [3]
    clock.advance(1)
    assert tiles.offer(make_frame(session_id, 3), "grid") is False
    assert tiles.offer(make_frame(session_id, 4), "grid") is True
    assert [frame.frame_seq for frame in tiles.pop_ready()] == [4]
