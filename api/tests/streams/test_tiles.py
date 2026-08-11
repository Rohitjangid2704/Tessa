import json

import pytest

from tessa_api.ids import new_id
from tessa_api.schemas.streams import TileQuality, stream_event_adapter
from tessa_api.streams.tiles import (
    ClientTiles,
    Demand,
    TileLimitExceededError,
    TilePolicy,
    clamp_quality,
    tile_policy,
)
from tests.streams.tile_support import FakeClock, make_frame, subscription
from tests.support import settings_with


def default_policy() -> TilePolicy:
    return tile_policy(settings_with())


def new_client(clock: FakeClock) -> ClientTiles:
    return ClientTiles(default_policy(), clock)


def test_clamp_keeps_values_inside_the_ceilings() -> None:
    assert clamp_quality(TileQuality(max_fps=4, quality=60, max_width=640)) == TileQuality(
        max_fps=4, quality=60, max_width=640
    )


def test_clamp_limits_frame_rate_quality_and_width() -> None:
    high = clamp_quality(TileQuality(max_fps=60, quality=100, max_width=4096))
    assert (high.max_fps, high.quality, high.max_width) == (15, 90, 1920)
    low = clamp_quality(TileQuality(max_fps=0, quality=1, max_width=0))
    assert (low.max_fps, low.quality, low.max_width) == (1, 30, 1)


def test_policy_from_settings_applies_the_clamps() -> None:
    policy = tile_policy(
        settings_with(
            live_grid_max_fps=60,
            live_grid_quality=5,
            live_grid_max_width=5000,
            live_focus_max_fps=20,
            live_focus_quality=100,
            live_max_tiles_per_client=7,
        )
    )
    assert policy.max_tiles == 7
    assert (policy.grid.max_fps, policy.grid.quality, policy.grid.max_width) == (15, 30, 1920)
    assert (policy.focus.max_fps, policy.focus.quality, policy.focus.max_width) == (15, 90, 1280)


def test_policy_limits_report_the_effective_values() -> None:
    limits = default_policy().limits()
    assert limits.max_tiles == 12
    assert limits.grid == TileQuality(max_fps=4, quality=60, max_width=640)
    assert limits.focus == TileQuality(max_fps=10, quality=75, max_width=1280)


def test_demand_is_zero_frames_per_second_when_nobody_wants_the_tile() -> None:
    assert default_policy().demand_for([]) == Demand(max_fps=0, quality=60, max_width=640)


def test_demand_of_one_mode_is_that_mode() -> None:
    policy = default_policy()
    assert policy.demand_for(["grid"]) == Demand(4, 60, 640)
    assert policy.demand_for(["focus", "focus"]) == Demand(10, 75, 1280)


def test_demand_is_the_maximum_across_subscribers_per_field() -> None:
    assert default_policy().demand_for(["grid", "focus", "grid"]) == Demand(10, 75, 1280)


def test_frame_text_is_a_valid_tile_frame_event_with_the_capture_time() -> None:
    frame = make_frame(new_id(), 3)
    event = json.loads(frame.text())
    assert event["type"] == "tile.frame"
    assert event["run_id"] == str(frame.run_id)
    assert event["seq"] is None
    assert event["ts"] == "2026-09-30T14:03:22.123Z"
    assert event["payload"]["frame_seq"] == 3
    assert stream_event_adapter.validate_python(event).type == "tile.frame"
    assert frame.text() is frame.text()


def test_an_explicit_subscriber_gets_no_frames_of_tiles_it_did_not_list() -> None:
    clock = FakeClock()
    client = new_client(clock)
    listed, other = new_id(), new_id()
    client.replace_subscription([subscription(listed)])
    assert client.offer(make_frame(other, 1), "grid") is False
    assert client.offer(make_frame(listed, 1), "grid") is True
    assert [frame.session_id for frame in client.pop_ready()] == [listed]


def test_a_client_that_never_subscribed_receives_the_tiles_offered_as_grid() -> None:
    client = new_client(FakeClock())
    session = new_id()
    assert client.explicit is False
    assert client.offer(make_frame(session, 1), "grid") is True
    assert client.mode_of(session) == "grid"
    assert len(client.pop_ready()) == 1


def test_the_slot_keeps_only_the_newest_frame() -> None:
    client = new_client(FakeClock())
    session = new_id()
    client.replace_subscription([subscription(session)])
    for frame_seq in (1, 2, 3):
        client.offer(make_frame(session, frame_seq), "grid")
    ready = client.pop_ready()
    assert [frame.frame_seq for frame in ready] == [3]
    channel = client.channel(session)
    assert channel is not None
    assert (channel.offered, channel.replaced, channel.sent) == (3, 2, 1)
    assert client.pop_ready() == []


def test_at_most_two_frames_are_unacked_per_tile() -> None:
    clock = FakeClock()
    client = new_client(clock)
    session = new_id()
    client.replace_subscription([subscription(session)])
    sent: list[int] = []
    for frame_seq in range(1, 6):
        client.offer(make_frame(session, frame_seq), "grid")
        clock.advance(1.0)
        sent.extend(frame.frame_seq for frame in client.pop_ready())
    assert sent == [1, 2]
    channel = client.channel(session)
    assert channel is not None
    assert list(channel.unacked) == [1, 2]
    assert client.seconds_until_ready() is None


def test_an_ack_is_cumulative_and_reopens_the_window() -> None:
    clock = FakeClock()
    client = new_client(clock)
    session = new_id()
    client.replace_subscription([subscription(session)])
    for frame_seq in (1, 2):
        client.offer(make_frame(session, frame_seq), "grid")
        clock.advance(1.0)
        client.pop_ready()
    client.offer(make_frame(session, 3), "grid")
    assert client.pop_ready() == []
    client.acknowledge(session, 2)
    channel = client.channel(session)
    assert channel is not None
    assert list(channel.unacked) == []
    clock.advance(1.0)
    assert [frame.frame_seq for frame in client.pop_ready()] == [3]


def test_acking_only_the_first_frame_leaves_one_in_flight() -> None:
    clock = FakeClock()
    client = new_client(clock)
    session = new_id()
    client.replace_subscription([subscription(session)])
    for frame_seq in (1, 2):
        client.offer(make_frame(session, frame_seq), "grid")
        clock.advance(1.0)
        client.pop_ready()
    client.acknowledge(session, 1)
    channel = client.channel(session)
    assert channel is not None
    assert list(channel.unacked) == [2]
    client.offer(make_frame(session, 3), "grid")
    clock.advance(1.0)
    assert [frame.frame_seq for frame in client.pop_ready()] == [3]
    assert list(channel.unacked) == [2, 3]


def test_an_ack_beyond_the_newest_sent_frame_clears_the_window_and_never_moves_back() -> None:
    clock = FakeClock()
    client = new_client(clock)
    session = new_id()
    client.replace_subscription([subscription(session)])
    for frame_seq in (1, 2):
        client.offer(make_frame(session, frame_seq), "grid")
        clock.advance(1.0)
        client.pop_ready()
    client.acknowledge(session, 99)
    client.acknowledge(session, 1)
    channel = client.channel(session)
    assert channel is not None
    assert channel.highest_acked == 99
    assert list(channel.unacked) == []


def test_an_ack_for_an_unlisted_tile_is_ignored() -> None:
    client = new_client(FakeClock())
    client.acknowledge(new_id(), 5)
    assert client.subscribed_ids() == set()


def test_frames_are_paced_to_the_frame_rate_of_the_mode() -> None:
    clock = FakeClock()
    client = new_client(clock)
    session = new_id()
    client.replace_subscription([subscription(session, "grid")])
    client.offer(make_frame(session, 1), "grid")
    assert len(client.pop_ready()) == 1
    client.acknowledge(session, 1)
    client.offer(make_frame(session, 2), "grid")
    assert client.pop_ready() == []
    wait = client.seconds_until_ready()
    assert wait is not None
    assert wait == pytest.approx(0.25)
    clock.advance(0.2)
    assert client.pop_ready() == []
    clock.advance(0.06)
    assert [frame.frame_seq for frame in client.pop_ready()] == [2]


def test_focus_mode_is_paced_faster_than_grid() -> None:
    clock = FakeClock()
    client = new_client(clock)
    session = new_id()
    client.replace_subscription([subscription(session, "focus")])
    client.offer(make_frame(session, 1), "focus")
    client.pop_ready()
    client.acknowledge(session, 1)
    client.offer(make_frame(session, 2), "focus")
    assert client.seconds_until_ready() == pytest.approx(0.1)


def test_resubscribing_keeps_the_window_of_a_tile_that_stays() -> None:
    clock = FakeClock()
    client = new_client(clock)
    kept, dropped = new_id(), new_id()
    client.replace_subscription([subscription(kept), subscription(dropped)])
    for frame_seq in (1, 2):
        client.offer(make_frame(kept, frame_seq), "grid")
        clock.advance(1.0)
        client.pop_ready()
    affected = client.replace_subscription([subscription(kept, "focus")])
    assert affected == {kept, dropped}
    channel = client.channel(kept)
    assert channel is not None
    assert list(channel.unacked) == [1, 2]
    assert channel.mode == "focus"
    assert client.channel(dropped) is None


def test_the_subscription_replaces_the_previous_set_and_may_be_empty() -> None:
    client = new_client(FakeClock())
    first, second = new_id(), new_id()
    client.replace_subscription([subscription(first)])
    client.replace_subscription([subscription(second)])
    assert client.subscribed_ids() == {second}
    client.replace_subscription([])
    assert client.subscribed_ids() == set()
    assert client.explicit is True


def test_a_tile_listed_twice_counts_once_and_the_last_mode_wins() -> None:
    client = new_client(FakeClock())
    session = new_id()
    client.replace_subscription([subscription(session, "grid"), subscription(session, "focus")])
    assert client.subscribed_ids() == {session}
    assert client.mode_of(session) == "focus"


def test_more_tiles_than_the_limit_are_refused_and_change_nothing() -> None:
    client = new_client(FakeClock())
    kept = new_id()
    client.replace_subscription([subscription(kept)])
    with pytest.raises(TileLimitExceededError) as caught:
        client.replace_subscription([subscription(new_id()) for _ in range(13)])
    assert (caught.value.limit, caught.value.requested) == (12, 13)
    assert client.subscribed_ids() == {kept}


def test_exactly_the_limit_is_accepted() -> None:
    client = new_client(FakeClock())
    client.replace_subscription([subscription(new_id()) for _ in range(12)])
    assert len(client.subscribed_ids()) == 12


def test_the_tile_limit_follows_the_setting() -> None:
    policy = tile_policy(settings_with(live_max_tiles_per_client=2))
    client = ClientTiles(policy, FakeClock())
    client.replace_subscription([subscription(new_id()), subscription(new_id())])
    with pytest.raises(TileLimitExceededError):
        client.replace_subscription([subscription(new_id()) for _ in range(3)])


def test_every_change_wakes_the_sender() -> None:
    client = new_client(FakeClock())
    session = new_id()
    client.changed.clear()
    client.replace_subscription([subscription(session)])
    assert client.changed.is_set()
    client.changed.clear()
    client.offer(make_frame(session, 1), "grid")
    assert client.changed.is_set()
    client.changed.clear()
    client.acknowledge(session, 1)
    assert client.changed.is_set()
