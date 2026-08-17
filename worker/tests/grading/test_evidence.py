import json
import string
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from pydantic import ValidationError

from tessa_api.schemas.bundle import Invariant
from tessa_api.schemas.enums import JudgeOrder
from tessa_api.schemas.grading import EvidenceBlock, EvidenceGoldPoint
from tessa_worker.grading.evidence import (
    DEFAULT_LIMITS,
    TRUNCATION_MARKER,
    EvidenceLimits,
    EvidenceSource,
    build_evidence,
    evidence_size_chars,
    has_reference,
    redact_json,
    redact_secrets,
)
from tessa_worker.grading.judge_prompt import estimate_tokens, render_judge_prompt
from tessa_worker.grading.rubric import RUBRIC_TEXT
from tests.grading.support import (
    ANSWER,
    ASK,
    GOLD_KEY,
    GOLD_RENDERED,
    evidence_block,
    gold_point,
)

ALLOW_LIST = {
    "ask",
    "answer",
    "gold_points",
    "must_not_claim",
    "unsupported_claim_candidates",
    "invariants",
    "rubric",
}
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"
PRIVATE_KEY = (
    "-----BEGIN RSA PRIVATE KEY-----\n"
    "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt\n"
    "-----END RSA PRIVATE KEY-----"
)
SECRETS = [
    "sk-Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A",
    "AKIAIOSFODNN7EXAMPLQ",
    "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    "xoxb-1234567890-abcdefghij",
    JWT,
    PRIVATE_KEY,
    "postgresql://tessa:Zq8Xw3Lk9Vb2Nm5R@db.internal:5432/tessa",
    "Bearer Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A",
]
SECRET_FRAGMENTS = [
    "Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A",
    "AKIAIOSFODNN7EXAMPLQ",
    "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    "xoxb-1234567890-abcdefghij",
    JWT,
    "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt",
    "Zq8Xw3Lk9Vb2Nm5R@",
]


def invariant(identifier: str = "no_claim_before_confirmation", rule: str = "Never claim.") -> Any:
    return Invariant.model_validate({"id": identifier, "rule": rule, "check": "probe"})


def source(**changes: Any) -> EvidenceSource:
    fields: dict[str, Any] = {"ask": ASK, "answer": ANSWER, "gold_points": [gold_point()]}
    fields.update(changes)
    return EvidenceSource(**fields)


def text_leaves(block: EvidenceBlock) -> list[str]:
    leaves: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, str):
            leaves.append(value)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)

    walk(block.model_dump(mode="json"))
    return leaves


def test_the_block_is_exactly_the_allow_list() -> None:
    assert set(EvidenceBlock.model_fields) == ALLOW_LIST
    assert set(json.loads(build_evidence(source()).model_dump_json())) == ALLOW_LIST


@pytest.mark.parametrize(
    "extra", [{"manifest": {}}, {"bundle": "text"}, {"description": "x"}, {"secrets": []}]
)
def test_a_key_outside_the_allow_list_is_rejected(extra: dict[str, Any]) -> None:
    payload = {**build_evidence(source()).model_dump(mode="json"), **extra}
    with pytest.raises(ValidationError):
        EvidenceBlock.model_validate(payload)


def test_nested_entries_carry_only_their_allowed_keys() -> None:
    block = build_evidence(source(invariants=[invariant()]))
    dumped = block.model_dump(mode="json")
    assert set(dumped["gold_points"][0]) == {"key", "value", "rendered"}
    assert set(dumped["invariants"][0]) == {"id", "rule"}
    with pytest.raises(ValidationError):
        EvidenceGoldPoint.model_validate({"key": "k", "value": 1, "rendered": "r", "extra": 1})


def test_the_oracle_result_id_of_a_gold_point_does_not_enter_the_block() -> None:
    point = gold_point()
    block = build_evidence(source(gold_points=[point]))
    assert str(point.oracle_result_id) not in block.model_dump_json()


def test_the_builder_keeps_the_question_the_answer_and_the_reference() -> None:
    block = build_evidence(source(must_not_claim=["The booking is confirmed"]))
    assert block.ask == ASK
    assert block.answer == ANSWER
    assert [point.key for point in block.gold_points] == [GOLD_KEY]
    assert block.gold_points[0].rendered == GOLD_RENDERED
    assert block.must_not_claim == ["The booking is confirmed"]
    assert block.rubric == RUBRIC_TEXT


def test_a_step_without_a_question_or_an_answer_stays_null() -> None:
    block = build_evidence(source(ask=None, answer=None))
    assert block.ask is None
    assert block.answer is None
    assert block.unsupported_claim_candidates == []


@pytest.mark.parametrize("secret", SECRETS)
def test_secrets_are_redacted_in_every_text_field(secret: str) -> None:
    text = f"before {secret} after"
    block = build_evidence(
        source(
            ask=text,
            answer=text,
            gold_points=[gold_point(key="k", rendered=text, value={"nested": [text]})],
            must_not_claim=[text],
            invariants=[invariant(rule=text)],
            rubric=text,
        )
    )
    dumped = block.model_dump_json()
    assert not any(fragment in dumped for fragment in SECRET_FRAGMENTS)
    assert "[REDACTED]" in dumped


def test_a_secret_assignment_is_redacted_and_the_rest_of_the_text_survives() -> None:
    redacted = redact_secrets("The config says api_key = Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A today")
    assert "Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A" not in redacted
    assert redacted.startswith("The config says")
    assert redacted.endswith("today")


def test_a_secret_assignment_after_a_colon_in_prose_is_still_redacted() -> None:
    redacted = redact_secrets("Here it is: api_key = Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A done")
    assert "Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A" not in redacted
    assert redacted.startswith("Here it is: api_key = ")


def test_an_ordinary_sentence_is_not_touched() -> None:
    assert redact_secrets(ANSWER) == ANSWER
    assert redact_json({"a": [1, "room 20003", None, True]}) == {"a": [1, "room 20003", None, True]}


def test_a_private_key_block_is_removed_with_its_body_across_lines() -> None:
    redacted = redact_secrets(f"key follows\n{PRIVATE_KEY}\nthen text")
    assert "MIIEow" not in redacted
    assert "then text" in redacted


def test_long_text_is_cut_at_the_limit_and_says_so() -> None:
    block = build_evidence(source(answer="a" * 10_000, ask="q" * 10_000))
    assert block.answer is not None
    assert block.ask is not None
    assert len(block.answer) == DEFAULT_LIMITS.answer_chars
    assert len(block.ask) == DEFAULT_LIMITS.ask_chars
    assert block.answer.endswith(TRUNCATION_MARKER)
    assert block.ask.endswith(TRUNCATION_MARKER)


def test_text_within_the_limit_is_kept_whole() -> None:
    block = build_evidence(source(answer="a" * DEFAULT_LIMITS.answer_chars))
    assert block.answer == "a" * DEFAULT_LIMITS.answer_chars


def test_lists_are_capped_to_their_limits() -> None:
    block = build_evidence(
        source(
            gold_points=[gold_point(key=f"k{index}") for index in range(40)],
            must_not_claim=[f"claim {index}" for index in range(40)],
            invariants=[invariant(f"inv_{index}") for index in range(40)],
        )
    )
    assert len(block.gold_points) == DEFAULT_LIMITS.gold_points
    assert len(block.must_not_claim) == DEFAULT_LIMITS.must_not_claim_items
    assert len(block.invariants) == DEFAULT_LIMITS.invariants


def test_a_large_gold_value_is_replaced_by_its_rendered_text() -> None:
    big = {"rows": list(range(500))}
    block = build_evidence(source(gold_points=[gold_point(value=big, rendered="500 rows")]))
    assert block.gold_points[0].value == "500 rows"


def test_a_small_gold_value_keeps_its_type() -> None:
    block = build_evidence(source(gold_points=[gold_point(value={"count": 3})]))
    assert block.gold_points[0].value == {"count": 3}


def test_the_worst_case_block_fits_the_judge_input_budget() -> None:
    long_gold = [
        gold_point(key="k" * 200, rendered="r" * 900, value={"v": "x" * 900}) for _ in range(30)
    ]
    block = build_evidence(
        source(
            ask="q" * 5000,
            answer="a" * 9000,
            gold_points=long_gold,
            must_not_claim=["m" * 900] * 30,
            invariants=[invariant("i" * 100, "r" * 900) for _ in range(30)],
            rubric="x" * 5000,
        )
    )
    assert sum(len(leaf) for leaf in text_leaves(block)) <= DEFAULT_LIMITS.worst_case_chars()
    prompt = render_judge_prompt(block, JudgeOrder.a_b)
    assert estimate_tokens(prompt) <= 6000


def test_unsupported_claim_candidates_are_sentences_with_numbers_no_reference_has() -> None:
    answer = "3 maintenance issues are open. The manager was paid 4500 dollars. Rooms are clean."
    block = build_evidence(source(answer=answer))
    assert block.unsupported_claim_candidates == ["The manager was paid 4500 dollars."]


def test_numbers_found_in_the_question_or_the_gold_values_are_supported() -> None:
    block = build_evidence(
        source(
            ask="How many rooms in 2026?",
            answer="There are 1,200 rooms in 2026.",
            gold_points=[gold_point(key="rooms", rendered="rooms", value=1200)],
        )
    )
    assert block.unsupported_claim_candidates == []


def test_there_are_no_candidates_without_a_reference() -> None:
    block = build_evidence(source(gold_points=[], answer="Paid 4500 dollars."))
    assert block.unsupported_claim_candidates == []
    assert not has_reference(block)


def test_a_reference_exists_when_gold_points_exist() -> None:
    assert has_reference(evidence_block())
    assert not has_reference(evidence_block(gold_points=[]))


def test_candidates_are_capped_and_deduplicated() -> None:
    answer = " ".join(f"Item {number} costs {number + 5000} units." for number in range(20))
    block = build_evidence(source(answer=answer))
    assert len(block.unsupported_claim_candidates) == DEFAULT_LIMITS.unsupported_candidates
    assert len(set(block.unsupported_claim_candidates)) == len(block.unsupported_claim_candidates)


def test_custom_limits_apply() -> None:
    limits = EvidenceLimits(answer_chars=40)
    block = build_evidence(source(answer="b" * 100), limits)
    assert block.answer is not None
    assert len(block.answer) == 40


def test_the_serialised_size_is_reported() -> None:
    block = evidence_block()
    assert evidence_size_chars(block) == len(block.model_dump_json())


printable = st.text(max_size=6000)
word = st.text(alphabet=string.ascii_letters + string.digits, min_size=24, max_size=40)
secret_forms = st.one_of(
    word.map(lambda token: f"sk-{token}"),
    st.text(alphabet=string.digits + string.ascii_uppercase, min_size=16, max_size=16).map(
        lambda token: f"AKIA{token}"
    ),
    st.text(alphabet=string.ascii_letters + string.digits, min_size=36, max_size=40).map(
        lambda token: f"ghp_{token}"
    ),
)
property_settings = settings(
    max_examples=80, deadline=None, suppress_health_check=[HealthCheck.too_slow]
)


@property_settings
@given(
    ask=st.none() | printable,
    answer=st.none() | printable,
    claims=st.lists(printable, max_size=30),
    rubric=printable,
)
def test_property_nothing_outside_the_allow_list_and_never_over_the_caps(
    ask: str | None, answer: str | None, claims: list[str], rubric: str
) -> None:
    block = build_evidence(
        source(
            ask=ask, answer=answer, must_not_claim=claims, rubric=rubric, invariants=[invariant()]
        )
    )
    assert set(json.loads(block.model_dump_json())) == ALLOW_LIST
    assert block.ask is None or len(block.ask) <= DEFAULT_LIMITS.ask_chars
    assert block.answer is None or len(block.answer) <= DEFAULT_LIMITS.answer_chars
    assert len(block.rubric) <= DEFAULT_LIMITS.rubric_chars
    assert len(block.must_not_claim) <= DEFAULT_LIMITS.must_not_claim_items
    assert all(len(claim) <= DEFAULT_LIMITS.must_not_claim_chars for claim in block.must_not_claim)
    assert sum(len(leaf) for leaf in text_leaves(block)) <= DEFAULT_LIMITS.worst_case_chars()


@property_settings
@given(
    prefix=printable.map(lambda text: text[:200]),
    secret=secret_forms,
    suffix=printable.map(lambda text: text[:200]),
)
def test_property_a_secret_never_survives_in_any_field(
    prefix: str, secret: str, suffix: str
) -> None:
    text = f"{prefix} {secret} {suffix}"
    block = build_evidence(source(ask=text, answer=text, must_not_claim=[text], rubric=text))
    assert secret not in block.model_dump_json()
    assert secret not in "".join(text_leaves(block))
