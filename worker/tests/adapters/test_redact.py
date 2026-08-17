import json
from urllib.parse import quote, quote_plus

from hypothesis import given, settings
from hypothesis import strategies as st
from pydantic import JsonValue

from tessa_worker.adapters.redact import Redactor, placeholder_for, secret_variants

secret_values = st.text(
    alphabet=st.characters(min_codepoint=33, max_codepoint=126), min_size=8, max_size=40
)
names = st.from_regex(r"[A-Z][A-Z0-9_]{2,15}", fullmatch=True)
filler = st.text(
    alphabet=st.characters(min_codepoint=97, max_codepoint=122), min_size=0, max_size=20
)

json_leaves = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(min_value=0, max_value=1000),
    st.text(alphabet=st.characters(min_codepoint=97, max_codepoint=122), max_size=20),
)
json_values = st.recursive(
    json_leaves,
    lambda children: st.one_of(
        st.lists(children, max_size=3),
        st.dictionaries(
            st.text(alphabet=st.characters(min_codepoint=97, max_codepoint=122), max_size=6),
            children,
            max_size=3,
        ),
    ),
    max_leaves=8,
)


def embed(value: JsonValue, secret: str, depth: int) -> JsonValue:
    wrapped: JsonValue = {"inner": [value, f"prefix-{secret}-suffix", {secret: secret}]}
    for _ in range(depth):
        wrapped = {"level": [wrapped, secret]}
    return wrapped


def test_text_is_returned_unchanged_when_no_secret_is_registered() -> None:
    redactor = Redactor()
    assert redactor.redact_text("Bearer abc") == "Bearer abc"
    assert redactor.max_secret_length == 0
    assert redactor.contains_secret("anything") is False


def test_a_registered_secret_becomes_its_placeholder() -> None:
    redactor = Redactor({"ADMIN_TOKEN": "tok-123456"})
    assert redactor.redact_text("Authorization: Bearer tok-123456") == (
        "Authorization: Bearer ${ADMIN_TOKEN}"
    )
    assert placeholder_for("ADMIN_TOKEN") == "${ADMIN_TOKEN}"


def test_every_occurrence_is_replaced() -> None:
    redactor = Redactor({"PW": "hunter2hunter2"})
    assert redactor.redact_text("a hunter2hunter2 b hunter2hunter2") == "a ${PW} b ${PW}"


def test_the_longer_secret_wins_when_one_contains_the_other() -> None:
    redactor = Redactor({"SHORT": "abcdefgh", "LONG": "abcdefghij"})
    assert redactor.redact_text("x abcdefghij y abcdefgh") == "x ${LONG} y ${SHORT}"


def test_url_encoded_and_json_escaped_forms_are_redacted_too() -> None:
    secret = 'p@ss word"/\\'
    redactor = Redactor({"PW": secret})
    for form in (secret, quote(secret, safe=""), quote_plus(secret), json.dumps(secret)[1:-1]):
        assert redactor.redact_text(f"value={form}&x=1") == "value=${PW}&x=1"


def test_values_are_redacted_in_nested_json_and_keys() -> None:
    redactor = Redactor({"TOKEN": "secret-token-1"})
    value: JsonValue = {"secret-token-1": ["a", {"k": "x secret-token-1 y"}], "n": 1, "t": True}
    assert redactor.redact_json(value) == {
        "${TOKEN}": ["a", {"k": "x ${TOKEN} y"}],
        "n": 1,
        "t": True,
    }


def test_headers_are_redacted_in_names_and_values() -> None:
    redactor = Redactor({"KEY": "key-value-123"})
    assert redactor.redact_mapping({"X-Key": "key-value-123", "Accept": "json"}) == {
        "X-Key": "${KEY}",
        "Accept": "json",
    }


def test_redact_object_keeps_a_dict() -> None:
    redactor = Redactor({"KEY": "key-value-123"})
    assert redactor.redact_object({"a": "key-value-123"}) == {"a": "${KEY}"}


def test_an_empty_secret_is_ignored() -> None:
    redactor = Redactor({"EMPTY": ""})
    assert redactor.redact_text("anything at all") == "anything at all"


def test_registering_later_takes_effect_and_the_first_name_wins_for_equal_values() -> None:
    redactor = Redactor({"FIRST": "shared-value-1"})
    assert redactor.redact_text("shared-value-1 later-secret-2") == "${FIRST} later-secret-2"
    redactor.register("SECOND", "shared-value-1")
    redactor.register("LATER", "later-secret-2")
    assert redactor.redact_text("shared-value-1 later-secret-2") == "${FIRST} ${LATER}"


def test_a_cut_text_is_redacted_first_and_then_loses_the_tail_that_may_hold_a_fragment() -> None:
    redactor = Redactor({"PW": "abcdefghij"})
    assert redactor.redact_prefix("0123456789 abcdefghij tail") == "0123456789 $"
    assert redactor.redact_prefix("0123456789 abcde") == "0123456"
    assert redactor.redact_prefix("abc") == ""
    assert Redactor().redact_prefix("abc") == "abc"
    assert Redactor({"PW": "a"}).redact_prefix("abc") == "${PW}bc"


@settings(max_examples=60, deadline=None)
@given(
    secret=secret_values,
    name=names,
    before=filler,
    cut_at=st.integers(min_value=0, max_value=60),
)
def test_property_no_prefix_of_a_secret_survives_a_cut(
    secret: str, name: str, before: str, cut_at: int
) -> None:
    redactor = Redactor({name: secret})
    text = f"{before}{secret}"
    start = len(before)
    cut = text[: start + min(cut_at, len(secret))]
    stored = redactor.redact_prefix(cut)
    for length in range(1, len(secret) + 1):
        fragment = secret[:length]
        if length >= 3 and fragment not in before:
            assert fragment not in stored.replace(placeholder_for(name), "")


def test_max_secret_length_counts_the_longest_variant() -> None:
    redactor = Redactor({"PW": "a b"})
    assert redactor.max_secret_length == max(len(variant) for variant in secret_variants("a b"))


def test_a_secret_split_across_two_strings_is_detected_only_when_joined() -> None:
    redactor = Redactor({"PW": "abcdefgh"})
    assert redactor.contains_secret("abcd") is False
    assert redactor.contains_secret("abcd" + "efgh") is True


@settings(max_examples=60, deadline=None)
@given(secret=secret_values, name=names, before=filler, after=filler)
def test_property_a_secret_never_survives_in_text(
    secret: str, name: str, before: str, after: str
) -> None:
    redactor = Redactor({name: secret})
    redacted = redactor.redact_text(f"{before}{secret}{after}")
    assert not redactor.contains_secret(redacted)
    assert placeholder_for(name) in redacted


@settings(max_examples=60, deadline=None)
@given(secret=secret_values, name=names, value=json_values, depth=st.integers(0, 4))
def test_property_a_secret_never_survives_in_nested_structures(
    secret: str, name: str, value: JsonValue, depth: int
) -> None:
    redactor = Redactor({name: secret})
    redacted = redactor.redact_json(embed(value, secret, depth))
    assert not redactor.contains_secret(json.dumps(redacted))


@settings(max_examples=60, deadline=None)
@given(secret=secret_values, name=names, other=secret_values)
def test_property_every_encoding_of_a_secret_is_redacted(
    secret: str, name: str, other: str
) -> None:
    redactor = Redactor({name: secret})
    for variant in secret_variants(secret):
        assert not redactor.contains_secret(redactor.redact_text(f"?q={variant}&r={other}"))
