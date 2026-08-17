from hypothesis import given
from hypothesis import strategies as st
from pydantic import JsonValue

from tessa_worker.adapters.payload import (
    fit_items,
    fit_json,
    fit_text,
    json_size,
    json_text,
)


def test_json_text_is_compact_and_keeps_unicode() -> None:
    assert json_text({"a": [1, 2], "b": "é"}) == '{"a":[1,2],"b":"é"}'
    assert json_size({"b": "é"}) == len('{"b":"é"}'.encode())


def test_text_within_the_limit_is_returned_whole() -> None:
    assert fit_text("hello", 5) == ("hello", False)


def test_text_over_the_limit_is_cut_and_flagged() -> None:
    assert fit_text("hello world", 5) == ("hello", True)


def test_a_cut_never_splits_a_multibyte_character() -> None:
    cut, truncated = fit_text("aé", 2)
    assert (cut, truncated) == ("a", True)


@given(text=st.text(max_size=200), limit=st.integers(min_value=0, max_value=100))
def test_property_cut_text_fits_the_limit_and_is_a_prefix(text: str, limit: int) -> None:
    cut, truncated = fit_text(text, limit)
    assert len(cut.encode()) <= limit
    assert text.startswith(cut)
    assert truncated == (len(text.encode()) > limit)


def test_json_within_the_limit_is_kept_as_a_value() -> None:
    fitted = fit_json({"a": 1}, 100)
    assert fitted.value == {"a": 1}
    assert fitted.text is None
    assert fitted.truncated is False


def test_json_over_the_limit_becomes_a_cut_text() -> None:
    fitted = fit_json({"payload": "x" * 100}, 20)
    assert fitted.value is None
    assert fitted.truncated is True
    assert fitted.text is not None
    assert len(fitted.text.encode()) <= 20
    assert fitted.text.startswith('{"payload":"xx')


def test_items_are_kept_until_the_budget_is_used() -> None:
    kept, truncated = fit_items(["aaa", "bbb", "ccc"], len, 7)
    assert (kept, truncated) == (["aaa", "bbb"], True)


def test_items_that_all_fit_are_returned_untruncated() -> None:
    kept, truncated = fit_items(["aaa", "bbb"], len, 6)
    assert (kept, truncated) == (["aaa", "bbb"], False)


def test_items_serialise_back_within_the_budget() -> None:
    items: list[JsonValue] = [{"i": index, "pad": "p" * 10} for index in range(50)]
    kept, truncated = fit_items(items, json_size, 200)
    assert truncated is True
    assert sum(json_size(item) for item in kept) <= 200
    assert kept == items[: len(kept)]
