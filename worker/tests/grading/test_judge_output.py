import json
from typing import Any

import pytest

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import VerdictStatus, VerdictTier
from tessa_worker.grading.judge_models import (
    JUDGE_ANSWER_SCHEMA,
    JudgeAnswer,
    JudgeOutputInvalidError,
    ProviderReply,
    parse_judge_answer,
)
from tessa_worker.grading.judge_verdict import (
    REASON_ORDER_DISAGREEMENT,
    REASON_OUTPUT_INVALID,
    combine_pair_verdicts,
    interpret_reply,
    judge_verdict,
    stamped_as_stub,
)
from tessa_worker.grading.pricing import TokenUsage
from tessa_worker.grading.stub_markers import STUB_REASON_CODE
from tests.fakes.openai import valid_answer
from tests.grading.support import GOLD_KEY, evidence_block

USAGE = TokenUsage(input_tokens=10, output_tokens=5)
UNSUPPORTED_KEYWORDS = {
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "pattern",
    "format",
    "default",
    "anyOf",
    "oneOf",
    "allOf",
}
ALL_STATUSES = [VerdictStatus.pass_, VerdictStatus.fail, VerdictStatus.uncertain]


def reply(answer: dict[str, Any] | str | None, **flags: bool) -> ProviderReply:
    text = answer if isinstance(answer, str) or answer is None else json.dumps(answer)
    return ProviderReply(text=text, usage=USAGE, **flags)


def keys_in(schema: Any) -> set[str]:
    if isinstance(schema, dict):
        found = set(schema)
        for value in schema.values():
            found |= keys_in(value)
        return found
    if isinstance(schema, list):
        return set().union(*(keys_in(item) for item in schema)) if schema else set()
    return set()


def test_the_schema_is_strict_mode_compatible() -> None:
    assert JUDGE_ANSWER_SCHEMA["type"] == "object"
    assert JUDGE_ANSWER_SCHEMA["additionalProperties"] is False
    assert set(JUDGE_ANSWER_SCHEMA["required"]) == set(JUDGE_ANSWER_SCHEMA["properties"])
    assert set(JUDGE_ANSWER_SCHEMA["properties"]) == set(JudgeAnswer.model_fields)
    assert keys_in(JUDGE_ANSWER_SCHEMA["properties"]).isdisjoint(UNSUPPORTED_KEYWORDS)
    assert JUDGE_ANSWER_SCHEMA["properties"]["verdict"]["enum"] == ["pass", "fail", "uncertain"]


def test_a_valid_answer_parses() -> None:
    answer = parse_judge_answer(json.dumps(valid_answer("fail", 0.4)))
    assert answer.verdict == "fail"
    assert answer.confidence == 0.4


@pytest.mark.parametrize(
    "payload",
    [
        {**valid_answer(), "override": True},
        {**valid_answer(), "verdict": "approved"},
        {**valid_answer(), "verdict": "PASS"},
        {**valid_answer(), "confidence": 1.5},
        {**valid_answer(), "confidence": -0.1},
        {**valid_answer(), "confidence": "high"},
        {**valid_answer(), "rationale": "   "},
        {**valid_answer(), "rationale": "x" * 2000},
        {**valid_answer(), "gold_points_used": "open_count"},
        {**valid_answer(), "must_not_claim_found": [-1]},
        {**valid_answer(), "must_not_claim_found": ["0"]},
        {**valid_answer(), "unsupported_claims": ["c"] * 11},
        {key: value for key, value in valid_answer().items() if key != "rationale"},
        [],
        "not an object",
    ],
)
def test_an_output_outside_the_schema_is_rejected(payload: Any) -> None:
    with pytest.raises(JudgeOutputInvalidError):
        parse_judge_answer(json.dumps(payload))


@pytest.mark.parametrize("text", ["", "not json", "{", '{"verdict": "pass"', "NaN"])
def test_text_that_is_not_json_is_rejected(text: str) -> None:
    with pytest.raises(JudgeOutputInvalidError):
        parse_judge_answer(text)


def test_nan_confidence_is_rejected() -> None:
    text = json.dumps(valid_answer()).replace("0.9", "NaN")
    with pytest.raises(JudgeOutputInvalidError):
        parse_judge_answer(text)


def test_the_rejection_reason_never_echoes_the_output() -> None:
    secret = "sk-Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A"
    with pytest.raises(JudgeOutputInvalidError) as caught:
        parse_judge_answer(json.dumps({**valid_answer(), "verdict": secret}))
    assert secret not in caught.value.reason


def test_a_valid_pass_becomes_a_judge_tier_verdict_with_the_gold_point_it_used() -> None:
    answer = valid_answer("pass", 0.93, gold_points_used=(GOLD_KEY,))
    result = interpret_reply(reply(answer), evidence_block())
    assert result.verdict.status is VerdictStatus.pass_
    assert result.verdict.tier is VerdictTier.judge
    assert result.verdict.confidence == 0.93
    assert result.verdict.reason == result.rationale
    assert [point.key for point in result.evidence.gold_points] == [GOLD_KEY]


def test_the_forbidden_claims_found_are_returned_as_text() -> None:
    evidence = evidence_block(must_not_claim=["it is confirmed", "it is free"])
    result = interpret_reply(reply(valid_answer("fail", must_not_claim_found=(1,))), evidence)
    assert result.verdict.status is VerdictStatus.fail
    assert result.evidence.must_not_claim == ["it is free"]


@pytest.mark.parametrize(
    "answer",
    [
        valid_answer("pass", gold_points_used=("not_a_gold_key",)),
        valid_answer("fail", must_not_claim_found=(0,)),
        valid_answer("pass", unsupported_claims=("a claim",)),
        {**valid_answer("pass"), "override": True},
    ],
)
def test_an_answer_that_contradicts_or_escapes_the_evidence_is_uncertain(
    answer: dict[str, Any],
) -> None:
    result = interpret_reply(reply(answer), evidence_block())
    assert result.verdict.status is VerdictStatus.uncertain
    assert result.verdict.reason_code == REASON_OUTPUT_INVALID
    assert result.verdict.confidence is None


def test_a_pass_with_a_found_forbidden_claim_is_never_a_pass() -> None:
    evidence = evidence_block(must_not_claim=["it is confirmed"])
    result = interpret_reply(reply(valid_answer("pass", must_not_claim_found=(0,))), evidence)
    assert result.verdict.status is VerdictStatus.uncertain


@pytest.mark.parametrize(
    "unusable",
    [
        reply(None),
        reply(valid_answer(), refused=True),
        reply(valid_answer(), incomplete=True),
        reply('{"verdict": "pass"'),
    ],
)
def test_an_unusable_reply_is_uncertain_and_never_a_pass(unusable: ProviderReply) -> None:
    result = interpret_reply(unusable, evidence_block())
    assert result.verdict.status is VerdictStatus.uncertain
    assert result.verdict.reason_code == REASON_OUTPUT_INVALID
    assert result.evidence.gold_points == []


def pair(first: VerdictStatus, second: VerdictStatus) -> tuple[Verdict, bool]:
    return combine_pair_verdicts(
        judge_verdict(first, 0.9, "x", "first"), judge_verdict(second, 0.7, "x", "second")
    )


@pytest.mark.parametrize("status", ALL_STATUSES)
def test_two_equal_verdicts_agree_and_keep_the_lower_confidence(status: VerdictStatus) -> None:
    combined, agrees = pair(status, status)
    assert agrees is True
    assert combined.status is status
    assert combined.confidence == 0.7


@pytest.mark.parametrize(
    ("first", "second"),
    [
        (VerdictStatus.pass_, VerdictStatus.fail),
        (VerdictStatus.fail, VerdictStatus.pass_),
        (VerdictStatus.pass_, VerdictStatus.uncertain),
        (VerdictStatus.uncertain, VerdictStatus.fail),
    ],
)
def test_two_different_verdicts_disagree_and_become_uncertain(
    first: VerdictStatus, second: VerdictStatus
) -> None:
    combined, agrees = pair(first, second)
    assert agrees is False
    assert combined.status is VerdictStatus.uncertain
    assert combined.reason_code == REASON_ORDER_DISAGREEMENT
    assert first.value in (combined.reason or "")
    assert second.value in (combined.reason or "")


def test_a_stub_pair_carries_the_stub_reason_code() -> None:
    combined, _ = combine_pair_verdicts(
        judge_verdict(VerdictStatus.pass_, 0.9, "x", "a"),
        judge_verdict(VerdictStatus.fail, 0.9, "x", "b"),
        stub=True,
    )
    assert combined.reason_code == STUB_REASON_CODE


def test_stamping_a_verdict_twice_changes_nothing_more() -> None:
    once = stamped_as_stub(judge_verdict(VerdictStatus.pass_, 0.9, "judge_pass", "fine"))
    assert once.reason_code == STUB_REASON_CODE
    assert once.reason == "[judge_pass] fine"
    assert stamped_as_stub(once) == once
