import json

from hypothesis import given
from hypothesis import strategies as st

from tessa_worker.adapters.sse_protocol import ChatAggregator, SseMessage, SseParser


def parse_all(chunks: list[bytes]) -> list[SseMessage]:
    parser = SseParser()
    messages: list[SseMessage] = []
    for chunk in chunks:
        messages.extend(parser.feed(chunk))
    messages.extend(parser.finish())
    return messages


def named(event: str, data: object) -> SseMessage:
    return SseMessage(event, json.dumps(data))


def test_a_named_event_is_dispatched_on_the_blank_line() -> None:
    assert parse_all([b"event: token\ndata: hi\n\n"]) == [SseMessage("token", "hi")]


def test_an_event_without_a_name_has_no_event() -> None:
    assert parse_all([b"data: hi\n\n"]) == [SseMessage(None, "hi")]


def test_multi_line_data_is_joined_with_newlines() -> None:
    assert parse_all([b"data: one\ndata: two\n\n"]) == [SseMessage(None, "one\ntwo")]


def test_comments_and_unknown_fields_are_ignored() -> None:
    chunk = b": ping\nid: 7\nretry: 100\nevent: x\ndata: y\n\n"
    assert parse_all([chunk]) == [SseMessage("x", "y")]


def test_a_single_leading_space_of_the_value_is_dropped_only_once() -> None:
    assert parse_all([b"data:  two spaces\n\n"]) == [SseMessage(None, " two spaces")]
    assert parse_all([b"data:none\n\n"]) == [SseMessage(None, "none")]


def test_crlf_cr_and_lf_line_endings_are_all_understood() -> None:
    assert parse_all([b"data: a\r\n\r\ndata: b\r\rdata: c\n\n"]) == [
        SseMessage(None, "a"),
        SseMessage(None, "b"),
        SseMessage(None, "c"),
    ]


def test_a_crlf_split_across_chunks_is_not_two_line_breaks() -> None:
    assert parse_all([b"data: a\r", b"\n\r", b"\ndata: b\n\n"]) == [
        SseMessage(None, "a"),
        SseMessage(None, "b"),
    ]


def test_a_multibyte_character_split_across_chunks_is_decoded() -> None:
    encoded = "data: héllo\n\n".encode()
    assert parse_all([encoded[:8], encoded[8:]]) == [SseMessage(None, "héllo")]


def test_an_event_without_the_final_blank_line_is_discarded() -> None:
    assert parse_all([b"data: done\n\ndata: cut"]) == [SseMessage(None, "done")]


def test_an_event_with_a_name_but_no_data_is_not_dispatched() -> None:
    assert parse_all([b"event: ping\n\ndata: x\n\n"]) == [SseMessage(None, "x")]


def test_a_trailing_cr_blank_line_is_flushed_at_the_end() -> None:
    assert parse_all([b"data: a\r\r"]) == [SseMessage(None, "a")]


@given(cuts=st.lists(st.integers(min_value=0, max_value=120), max_size=6))
def test_property_chunking_never_changes_the_events(cuts: list[int]) -> None:
    stream = (
        b'event: tool_call\r\ndata: {"name": "a"}\r\n\r\n'
        b"event: token\ndata: h\xc3\xa9llo\n\n"
        b"data: one\ndata: two\n\n"
        b"event: done\rdata: {}\r\r"
    )
    points = sorted({min(cut, len(stream)) for cut in cuts})
    pieces = [
        stream[start:end] for start, end in zip([0, *points], [*points, len(stream)], strict=True)
    ]
    assert parse_all(pieces) == parse_all([stream])


def test_tokens_are_concatenated_into_the_answer() -> None:
    aggregator = ChatAggregator()
    for message in (named("token", {"text": "Hello "}), named("token", {"text": "world"})):
        aggregator.add(message)
    assert aggregator.answer == "Hello world"


def test_text_events_accept_json_strings_raw_text_and_known_keys() -> None:
    aggregator = ChatAggregator()
    aggregator.add(SseMessage("delta", json.dumps("a")))
    aggregator.add(SseMessage("token", "b"))
    aggregator.add(SseMessage(None, json.dumps({"content": "c"})))
    aggregator.add(SseMessage("message", json.dumps({"delta": "d"})))
    assert aggregator.answer == "abcd"


def test_a_token_that_looks_like_a_number_is_kept_as_text() -> None:
    aggregator = ChatAggregator()
    aggregator.add(SseMessage("token", "42"))
    aggregator.add(SseMessage("token", " rooms"))
    assert aggregator.answer == "42 rooms"


def test_no_text_event_means_no_answer_not_an_empty_one() -> None:
    aggregator = ChatAggregator()
    aggregator.add(named("tool_call", {"name": "t", "args": {}}))
    assert aggregator.answer is None


def test_an_empty_token_gives_an_empty_answer() -> None:
    aggregator = ChatAggregator()
    aggregator.add(named("token", {"text": ""}))
    assert aggregator.answer == ""


def test_the_done_event_supplies_the_answer_when_there_were_no_tokens() -> None:
    aggregator = ChatAggregator()
    aggregator.add(named("done", {"answer": "All done", "cost_usd": 0.0125}))
    assert aggregator.answer == "All done"
    assert aggregator.cost_usd == 0.0125


def test_tokens_win_over_the_done_answer() -> None:
    aggregator = ChatAggregator()
    aggregator.add(named("token", {"text": "streamed"}))
    aggregator.add(named("done", {"answer": "final"}))
    assert aggregator.answer == "streamed"


def test_a_negative_or_non_numeric_cost_is_ignored() -> None:
    aggregator = ChatAggregator()
    aggregator.add(named("done", {"cost_usd": -1}))
    aggregator.add(named("done", {"cost_usd": "free"}))
    aggregator.add(named("done", {"cost_usd": True}))
    assert aggregator.cost_usd == 0.0


def test_tool_calls_carry_name_args_and_a_result_summary() -> None:
    aggregator = ChatAggregator()
    aggregator.add(
        named(
            "tool_call", {"name": "query", "args": {"status": "open"}, "result_summary": "3 rows"}
        )
    )
    aggregator.add(named("tool", {"tool": "other", "arguments": '{"a": 1}', "result": [1, 2]}))
    first, second = aggregator.tools
    assert (first.name, first.args, first.result_summary) == ("query", {"status": "open"}, "3 rows")
    assert (second.name, second.args, second.result_summary) == ("other", {"a": 1}, "[1,2]")


def test_a_tool_result_event_fills_the_matching_call() -> None:
    aggregator = ChatAggregator()
    aggregator.add(named("tool_call", {"id": "c1", "name": "a", "args": {}}))
    aggregator.add(named("tool_call", {"id": "c2", "name": "b", "args": {}}))
    aggregator.add(named("tool_result", {"id": "c1", "result": "first"}))
    assert [tool.result_summary for tool in aggregator.tools] == ["first", None]


def test_a_tool_result_without_an_id_matches_the_latest_call_by_name() -> None:
    aggregator = ChatAggregator()
    aggregator.add(named("tool_call", {"name": "a", "args": {}}))
    aggregator.add(named("tool_call", {"name": "a", "args": {"n": 2}}))
    aggregator.add(named("tool_result", {"name": "a", "summary": "later"}))
    assert [tool.result_summary for tool in aggregator.tools] == [None, "later"]


def test_a_malformed_tool_event_is_ignored() -> None:
    aggregator = ChatAggregator()
    aggregator.add(SseMessage("tool_call", "not json"))
    aggregator.add(named("tool_call", {"args": {}}))
    assert aggregator.tools == []


def test_cards_accept_an_object_a_list_and_keep_unparseable_data_as_raw() -> None:
    aggregator = ChatAggregator()
    aggregator.add(named("card", {"kind": "a"}))
    aggregator.add(named("cards", [{"kind": "b"}, {"kind": "c"}, 7]))
    aggregator.add(SseMessage("card", "plain"))
    assert aggregator.cards == [{"kind": "a"}, {"kind": "b"}, {"kind": "c"}, {"raw": "plain"}]


def test_unknown_events_and_the_openai_end_marker_are_ignored() -> None:
    aggregator = ChatAggregator()
    aggregator.add(SseMessage("error", json.dumps({"message": "boom"})))
    aggregator.add(SseMessage(None, "[DONE]"))
    assert aggregator.answer is None
    assert aggregator.tools == []
    assert aggregator.cards == []
