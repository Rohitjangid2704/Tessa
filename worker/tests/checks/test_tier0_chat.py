import pytest
from pydantic import JsonValue

from tessa_api.schemas.enums import Tier0Check
from tessa_worker.checks.contracts import Tier0Context
from tessa_worker.checks.tier0 import evaluate_tier0
from tests.checks.support import CONTEXT, checks_of, sse_expect, sse_record


@pytest.mark.parametrize(
    ("expected", "actual", "passes"),
    [(200, 200, True), (200, 500, False), ([200, 201], 201, True), (None, 500, True)],
)
def test_status_of_the_stream_response(
    expected: int | list[int] | None, actual: int, passes: bool
) -> None:
    expect = sse_expect(status=expected) if expected is not None else sse_expect()
    result = evaluate_tier0(sse_record(status=actual), expect, CONTEXT)
    assert result.passed is passes


@pytest.mark.parametrize(
    ("events", "include", "exclude", "passes"),
    [
        (["token", "done"], ["done"], [], True),
        (["token"], ["done"], [], False),
        (["token", "done"], [], ["error"], True),
        (["token", "error"], [], ["error"], False),
        ([None, "done"], ["message"], [], True),
        (["token"], ["done", "card"], [], False),
        (["token", "done"], ["done"], ["error"], True),
    ],
)
def test_event_expectations_are_reported_under_status(
    events: list[str | None], include: list[str], exclude: list[str], passes: bool
) -> None:
    record = sse_record(events=[(name, index) for index, name in enumerate(events)])
    expect = sse_expect(events={"include": include, "exclude": exclude})
    result = evaluate_tier0(record, expect, CONTEXT)
    assert result.passed is passes
    assert set(checks_of(result.failures)) <= {Tier0Check.status}


def test_a_cut_stream_cannot_confirm_that_an_event_is_absent() -> None:
    expect = sse_expect(events={"exclude": ["error"]})
    record = sse_record(events=[("token", 1)], truncated=True)
    result = evaluate_tier0(record, expect, CONTEXT)
    assert result.passed is False
    assert "cut" in result.failures[0].message
    seen_error = sse_record(events=[("error", 1)], truncated=True)
    assert evaluate_tier0(seen_error, expect, CONTEXT).passed is False


def test_a_cut_stream_can_still_confirm_a_present_event() -> None:
    record = sse_record(events=[("token", 1), ("done", 2)], truncated=True)
    assert evaluate_tier0(record, sse_expect(events={"include": ["done"]}), CONTEXT).passed is True


def test_a_timed_out_stream_fails_the_status_check_with_the_reason() -> None:
    record = sse_record(ok=False, error="the stream did not end within 5s")
    [failure] = evaluate_tier0(record, sse_expect(), CONTEXT).failures
    assert failure.check is Tier0Check.status
    assert "did not end" in failure.message


def test_a_stream_without_a_response_only_reports_the_adapter_failure() -> None:
    record = sse_record(ok=False, error="ConnectError: refused", with_response=False)
    result = evaluate_tier0(record, sse_expect(text_contains=["x"]), CONTEXT)
    assert checks_of(result.failures) == [Tier0Check.status]


TOOLS: list[tuple[str, dict[str, JsonValue]]] = [
    ("query_issues", {"status": "open", "limit": 5}),
    ("draft_issue", {"room": "20003"}),
]


@pytest.mark.parametrize(
    ("tools", "passes"),
    [
        ({"include": ["query_issues"]}, True),
        ({"include": ["query_issues", "draft_issue"]}, True),
        ({"include": ["delete_all"]}, False),
        ({"include": ["query_issues", "delete_all"]}, False),
        ({"include": [{"name": "query_issues", "args": {"status": "open"}}]}, True),
        ({"include": [{"name": "query_issues", "args": {"status": "closed"}}]}, False),
        ({"include": [{"name": "query_issues", "args": {"missing": 1}}]}, False),
        ({"include": [{"name": "query_issues", "args": {"limit": 5, "status": "open"}}]}, True),
        ({"include": [{"name": "query_issues", "args": {"limit": True}}]}, False),
        ({"exclude": ["delete_all"]}, True),
        ({"exclude": ["draft_issue"]}, False),
        ({"exclude": [{"name": "draft_issue", "args": {"room": "99999"}}]}, True),
        ({"exclude": [{"name": "draft_issue", "args": {"room": "20003"}}]}, False),
        ({"none": True}, False),
        ({"at_least_one": True}, True),
        ({"max_calls": 2}, True),
        ({"max_calls": 1}, False),
        ({"max_calls": 0}, False),
    ],
)
def test_tools_truth_table(tools: dict[str, JsonValue], passes: bool) -> None:
    result = evaluate_tier0(sse_record(tools=TOOLS), sse_expect(tools=tools), CONTEXT)
    assert result.passed is passes, result.failures
    assert set(checks_of(result.failures)) <= {Tier0Check.tools}


@pytest.mark.parametrize(
    ("tools", "passes"),
    [
        ({"none": True}, True),
        ({"at_least_one": True}, False),
        ({"include": ["query_issues"]}, False),
        ({"exclude": ["query_issues"]}, True),
        ({"max_calls": 0}, True),
    ],
)
def test_tools_truth_table_when_no_tool_was_called(
    tools: dict[str, JsonValue], passes: bool
) -> None:
    result = evaluate_tier0(sse_record(tools=[]), sse_expect(tools=tools), CONTEXT)
    assert result.passed is passes


def test_a_missing_tool_failure_lists_the_calls_that_were_made() -> None:
    [failure] = evaluate_tier0(
        sse_record(tools=TOOLS), sse_expect(tools={"include": ["delete_all"]}), CONTEXT
    ).failures
    assert failure.expected == "delete_all"
    assert failure.actual == ["query_issues", "draft_issue"]


CARDS: list[dict[str, JsonValue]] = [
    {"kind": "issue_list", "count": 3, "rooms": ["20003", "20005"]},
    {"kind": "confirmation", "details": {"room": "20003", "action": "create"}},
]


@pytest.mark.parametrize(
    ("cards", "passes"),
    [
        ({"min_count": 2}, True),
        ({"min_count": 3}, False),
        ({"max_count": 2}, True),
        ({"max_count": 1}, False),
        ({"include": [{"kind": "issue_list"}]}, True),
        ({"include": [{"kind": "issue_list", "count": 3}]}, True),
        ({"include": [{"kind": "issue_list", "count": 4}]}, False),
        ({"include": [{"kind": "unknown"}]}, False),
        ({"include": [{"kind": "confirmation", "details": {"room": "20003"}}]}, True),
        ({"include": [{"kind": "confirmation", "details": {"room": "99999"}}]}, False),
        ({"include": [{"kind": "issue_list", "rooms": ["20003", "20005"]}]}, True),
        ({"include": [{"kind": "issue_list", "rooms": ["20003"]}]}, False),
        ({"include": [{"kind": "issue_list"}, {"kind": "confirmation"}], "min_count": 2}, True),
        ({"include": [{"kind": "issue_list", "count": True}]}, False),
    ],
)
def test_cards_truth_table(cards: dict[str, JsonValue], passes: bool) -> None:
    result = evaluate_tier0(sse_record(cards=CARDS), sse_expect(cards=cards), CONTEXT)
    assert result.passed is passes, result.failures
    assert set(checks_of(result.failures)) <= {Tier0Check.cards}


def test_cards_when_none_were_shown() -> None:
    assert evaluate_tier0(sse_record(), sse_expect(cards={"max_count": 0}), CONTEXT).passed
    assert not evaluate_tier0(sse_record(), sse_expect(cards={"min_count": 1}), CONTEXT).passed
    assert not evaluate_tier0(
        sse_record(), sse_expect(cards={"include": [{"kind": "x"}]}), CONTEXT
    ).passed


ANSWER = "Three Rooms are dirty: 20002, 20003 and 20005."


@pytest.mark.parametrize(
    ("text_contains", "passes"),
    [
        (["rooms are dirty"], True),
        (["ROOMS ARE DIRTY"], True),
        (["20002", "20005"], True),
        (["20002", "99999"], False),
        (["clean"], False),
        ([], True),
    ],
)
def test_text_contains_truth_table(text_contains: list[str], passes: bool) -> None:
    result = evaluate_tier0(
        sse_record(answer=ANSWER),
        sse_expect(text_contains=text_contains, internal_ids=False),
        CONTEXT,
    )
    assert result.passed is passes
    assert set(checks_of(result.failures)) <= {Tier0Check.text_contains}


@pytest.mark.parametrize(
    ("accepted", "passes"),
    [(["clean", "dirty"], True), (["clean", "tidy"], False), (["DIRTY"], True), ([], True)],
)
def test_text_contains_any_truth_table(accepted: list[str], passes: bool) -> None:
    result = evaluate_tier0(
        sse_record(answer=ANSWER), sse_expect(text_contains_any=accepted), CONTEXT
    )
    assert result.passed is passes
    assert set(checks_of(result.failures)) <= {Tier0Check.text_contains}


@pytest.mark.parametrize(
    ("answer", "non_empty", "passes"),
    [
        ("text", True, True),
        ("", True, False),
        ("   \n", True, False),
        (None, True, True),
        ("", False, True),
        (None, False, True),
    ],
)
def test_non_empty_answer_truth_table(answer: str | None, non_empty: bool, passes: bool) -> None:
    result = evaluate_tier0(
        sse_record(answer=answer), sse_expect(non_empty_answer=non_empty), CONTEXT
    )
    assert result.passed is passes
    if not passes:
        assert checks_of(result.failures) == [Tier0Check.text_contains]


def test_text_contains_without_an_extracted_answer_fails() -> None:
    result = evaluate_tier0(sse_record(answer=None), sse_expect(text_contains=["x"]), CONTEXT)
    assert checks_of(result.failures) == [Tier0Check.text_contains]
    assert "no answer" in result.failures[0].message


@pytest.mark.parametrize(
    ("forbidden", "passes"),
    [
        (["I have created"], True),
        (["dirty"], False),
        (["DIRTY"], False),
        (["clean", "tidy"], True),
        (["clean", "20003"], False),
        ([], True),
    ],
)
def test_text_not_contains_truth_table(forbidden: list[str], passes: bool) -> None:
    result = evaluate_tier0(
        sse_record(answer=ANSWER),
        sse_expect(text_not_contains=forbidden, internal_ids=False),
        CONTEXT,
    )
    assert result.passed is passes
    assert set(checks_of(result.failures)) <= {Tier0Check.text_not_contains}


def test_text_not_contains_passes_without_an_answer_and_is_inconclusive_when_cut() -> None:
    expect = sse_expect(text_not_contains=["secret"])
    assert evaluate_tier0(sse_record(answer=None), expect, CONTEXT).passed is True
    cut = evaluate_tier0(sse_record(answer="all fine", truncated=True), expect, CONTEXT)
    assert checks_of(cut.failures) == [Tier0Check.text_not_contains]
    assert "cut" in cut.failures[0].message
    found = evaluate_tier0(sse_record(answer="a secret", truncated=True), expect, CONTEXT)
    assert "must not appear" in found.failures[0].message


@pytest.mark.parametrize(
    ("limits", "first_event_at", "latency", "expected_failures"),
    [
        ({"max_ms": 500}, 5, 500, 0),
        ({"max_ms": 500}, 5, 501, 1),
        ({"max_first_byte_ms": 100}, 100, 10, 0),
        ({"max_first_byte_ms": 100}, 101, 10, 1),
        ({"max_ms": 500, "max_first_byte_ms": 100}, 100, 500, 0),
        ({"max_ms": 500, "max_first_byte_ms": 100}, 200, 600, 2),
    ],
)
def test_sse_latency_truth_table(
    limits: dict[str, JsonValue], first_event_at: int, latency: int, expected_failures: int
) -> None:
    record = sse_record(events=[("token", first_event_at), ("done", 9)], latency_ms=latency)
    result = evaluate_tier0(record, sse_expect(latency=limits), CONTEXT)
    assert len(result.failures) == expected_failures
    assert set(checks_of(result.failures)) <= {Tier0Check.latency}


def test_the_first_byte_check_needs_an_event() -> None:
    result = evaluate_tier0(
        sse_record(events=[]), sse_expect(latency={"max_first_byte_ms": 100}), CONTEXT
    )
    assert checks_of(result.failures) == [Tier0Check.latency]
    assert "no event" in result.failures[0].message


ID_ANSWERS = [
    (
        "The internal id of room 20003 is room_id 4002 (3f2c9a52-0b1e-4f57-8f73-2d2a1b9c7e10).",
        False,
    ),
    ("Ticket id: 4521 was updated", False),
    ("Your ID 8841 is ready", False),
    ('{"id": 17}', False),
    ("session fake-session-0123456789abcdef0123456789abcdef", False),
    ("Room 20003 has 3 issues on 2026-10-05", True),
    ("The hotel paid 100 and the plan is valid 12 months", True),
    ("Call 5551234567 for help", True),
    ("Three rooms are dirty: 20002, 20003 and 20005.", True),
]


@pytest.mark.parametrize(("answer", "passes"), ID_ANSWERS)
def test_internal_ids_in_an_answer(answer: str, passes: bool) -> None:
    context = Tier0Context(
        internal_id_patterns=(*CONTEXT.internal_id_patterns, r"\bfake-session-[0-9a-f]{32}\b")
    )
    result = evaluate_tier0(sse_record(answer=answer), sse_expect(), context)
    assert result.passed is passes
    assert set(checks_of(result.failures)) <= {Tier0Check.internal_ids}


def test_internal_ids_can_be_switched_off_and_a_missing_answer_passes() -> None:
    off = evaluate_tier0(sse_record(answer="room_id 4002"), sse_expect(internal_ids=False), CONTEXT)
    assert off.passed
    assert evaluate_tier0(sse_record(answer=None), sse_expect(), CONTEXT).passed


def test_a_bundle_pattern_adds_to_the_defaults() -> None:
    context = Tier0Context(internal_id_patterns=(r"\bSKU-\d+\b",))
    assert not evaluate_tier0(sse_record(answer="item SKU-1234"), sse_expect(), context).passed
    assert evaluate_tier0(sse_record(answer="item 1234"), sse_expect(), context).passed


def test_failures_come_in_check_order_across_the_chat_checks() -> None:
    record = sse_record(
        answer="room_id 4002 forbidden",
        tools=[],
        cards=[],
        status=500,
        latency_ms=900,
        events=[("token", 1)],
    )
    expect = sse_expect(
        status=200,
        events={"include": ["done"]},
        tools={"at_least_one": True},
        cards={"min_count": 1},
        text_contains=["missing"],
        text_not_contains=["forbidden"],
        latency={"max_ms": 100},
    )
    result = evaluate_tier0(record, expect, CONTEXT)
    assert checks_of(result.failures) == [
        Tier0Check.status,
        Tier0Check.status,
        Tier0Check.latency,
        Tier0Check.tools,
        Tier0Check.cards,
        Tier0Check.internal_ids,
        Tier0Check.text_contains,
        Tier0Check.text_not_contains,
    ]
