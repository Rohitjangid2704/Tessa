import re

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tessa_api.schemas.steps import Tier0Result
from tessa_worker.adapters.base import StepRecord
from tessa_worker.checks.common import Tier0MismatchError
from tessa_worker.checks.contracts import StepExpectations, Tier0Context, Tier0Evaluator
from tessa_worker.checks.internal_ids import (
    DEFAULT_INTERNAL_ID_PATTERNS,
    MAX_PATTERN_LENGTH,
    build_tier0_context,
    find_internal_ids,
)
from tessa_worker.checks.tier0 import evaluate_tier0
from tests.adapters.support import minimal_manifest
from tests.checks.support import (
    CONTEXT,
    browser_expect,
    browser_record,
    http_expect,
    http_record,
    sse_expect,
    sse_record,
)


def test_the_evaluator_satisfies_the_seam_protocol() -> None:
    evaluator: Tier0Evaluator = evaluate_tier0
    result = evaluator(http_record(), http_expect(status=200), CONTEXT)
    assert isinstance(result, Tier0Result)
    assert result.passed is True
    assert result.failures == []


@pytest.mark.parametrize(
    ("record", "expect"),
    [
        (http_record(), sse_expect()),
        (http_record(), browser_expect()),
        (sse_record(), http_expect()),
        (sse_record(), browser_expect()),
        (browser_record(), http_expect()),
        (browser_record(), sse_expect()),
    ],
)
def test_expectations_of_another_adapter_kind_are_refused(
    record: StepRecord, expect: StepExpectations
) -> None:
    with pytest.raises(Tier0MismatchError, match="cannot be evaluated"):
        evaluate_tier0(record, expect, CONTEXT)


def test_the_evaluation_is_pure() -> None:
    record = http_record(status=500, body={"id": "3f2c9a52-0b1e-4f57-8f73-2d2a1b9c7e10"})
    expect = http_expect(status=200)
    before = record.model_dump_json()
    first = evaluate_tier0(record, expect, CONTEXT)
    second = evaluate_tier0(record, expect, CONTEXT)
    assert first == second
    assert record.model_dump_json() == before


def test_the_default_context_holds_the_uuid_and_numeric_id_patterns() -> None:
    context = build_tier0_context(minimal_manifest())
    assert context.internal_id_patterns == DEFAULT_INTERNAL_ID_PATTERNS
    assert len(context.internal_id_patterns) == 2


def invariants_manifest(invariants: list[dict[str, object]]) -> Tier0Context:
    manifest = minimal_manifest()
    document = manifest.model_dump(mode="json", by_alias=True)
    document["invariants"] = invariants
    return build_tier0_context(type(manifest).model_validate(document))


def test_the_internal_id_invariant_adds_its_patterns() -> None:
    context = invariants_manifest(
        [
            {
                "id": "no_internal_ids",
                "rule": "none",
                "check": "code",
                "internal_id_patterns": [r"\bSKU-\d+\b", r"\bsess_[a-z0-9]{8}\b"],
            }
        ]
    )
    assert context.internal_id_patterns == (
        *DEFAULT_INTERNAL_ID_PATTERNS,
        r"\bSKU-\d+\b",
        r"\bsess_[a-z0-9]{8}\b",
    )


def test_a_single_pattern_string_is_accepted() -> None:
    context = invariants_manifest(
        [{"id": "no_internal_ids", "rule": "a", "check": "code", "internal_id_patterns": "A-1"}]
    )
    assert context.internal_id_patterns == (*DEFAULT_INTERNAL_ID_PATTERNS, "A-1")


def test_duplicate_patterns_are_dropped() -> None:
    context = invariants_manifest(
        [
            {
                "id": "no_internal_ids",
                "rule": "a",
                "check": "code",
                "internal_id_patterns": ["A-1", "B-2", "A-1"],
            }
        ]
    )
    assert context.internal_id_patterns == (*DEFAULT_INTERNAL_ID_PATTERNS, "A-1", "B-2")


def test_patterns_that_do_not_compile_or_are_too_long_or_not_text_are_ignored() -> None:
    context = invariants_manifest(
        [
            {
                "id": "no_internal_ids",
                "rule": "x",
                "check": "code",
                "internal_id_patterns": ["(", "x" * (MAX_PATTERN_LENGTH + 1), 5, "", "ok-\\d"],
            }
        ]
    )
    assert context.internal_id_patterns == (*DEFAULT_INTERNAL_ID_PATTERNS, "ok-\\d")


def test_patterns_on_other_invariants_are_not_internal_id_patterns() -> None:
    context = invariants_manifest(
        [{"id": "other", "rule": "x", "check": "code", "internal_id_patterns": ["zzz"]}]
    )
    assert context.internal_id_patterns == DEFAULT_INTERNAL_ID_PATTERNS


def test_a_bundle_pattern_is_used_by_the_check() -> None:
    context = invariants_manifest(
        [
            {
                "id": "no_internal_ids",
                "rule": "x",
                "check": "code",
                "internal_id_patterns": ["SKU-\\d+"],
            }
        ]
    )
    result = evaluate_tier0(sse_record(answer="item SKU-77 is ready"), sse_expect(), context)
    assert result.passed is False


def test_the_context_is_frozen() -> None:
    assert Tier0Context(internal_id_patterns=("a",)).model_config["frozen"] is True


def test_finding_ids_reports_each_distinct_match_once_up_to_five() -> None:
    text = " ".join(f"room_id {1000 + index}" for index in range(10)) + " room_id 1000"
    found = find_internal_ids(text, DEFAULT_INTERNAL_ID_PATTERNS)
    assert len(found) == 5
    assert len(set(found)) == 5


@given(text=st.text(alphabet="abc xyz.,:-", max_size=80))
def test_property_plain_prose_never_matches_the_default_patterns(text: str) -> None:
    assert find_internal_ids(text, DEFAULT_INTERNAL_ID_PATTERNS) == []


@given(number=st.integers(min_value=10, max_value=10**9))
def test_property_a_labelled_numeric_id_always_matches(number: int) -> None:
    for label in ("id", "room_id", "user_id", "ID"):
        found = find_internal_ids(f"the {label}: {number} here", DEFAULT_INTERNAL_ID_PATTERNS)
        assert found
        assert re.search(str(number), found[0])
