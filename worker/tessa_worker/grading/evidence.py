import json
import logging
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Protocol

from pydantic import JsonValue

from tessa_api.schemas.grading import EvidenceBlock, EvidenceGoldPoint, EvidenceInvariant
from tessa_api.services.secret_scan import (
    REDACTION,
    SENSITIVE_ASSIGNMENT,
    SpanMatch,
    find_matches,
    is_sensitive_name,
    looks_like_real_secret,
    merge_spans,
)
from tessa_worker.grading.rubric import RUBRIC_TEXT

logger = logging.getLogger("tessa_worker.grading.evidence")

TRUNCATION_MARKER = " [truncated]"
NAME_TOKEN_START = re.compile(r"(?<![A-Za-z0-9_.\-])[A-Za-z0-9_.\-]{1,80}")
SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+|\n+")
NUMERIC_TOKEN = re.compile(r"\d+(?:[.,:/-]\d+)*")
PRIVATE_KEY_BLOCK = re.compile(
    r"-----BEGIN (?:[A-Z]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END [^-\n]*-----|\Z)",
    re.DOTALL,
)


@dataclass(frozen=True, slots=True)
class EvidenceLimits:
    ask_chars: int = 500
    answer_chars: int = 2500
    gold_points: int = 10
    gold_key_chars: int = 60
    gold_rendered_chars: int = 200
    gold_value_chars: int = 120
    must_not_claim_items: int = 8
    must_not_claim_chars: int = 160
    unsupported_candidates: int = 5
    unsupported_candidate_chars: int = 200
    invariants: int = 6
    invariant_id_chars: int = 60
    invariant_rule_chars: int = 240
    rubric_chars: int = 1000

    def worst_case_chars(self) -> int:
        gold = self.gold_points * (
            self.gold_key_chars + self.gold_rendered_chars + self.gold_value_chars
        )
        must_not_claim = self.must_not_claim_items * self.must_not_claim_chars
        candidates = self.unsupported_candidates * self.unsupported_candidate_chars
        invariants = self.invariants * (self.invariant_id_chars + self.invariant_rule_chars)
        return (
            self.ask_chars
            + self.answer_chars
            + gold
            + must_not_claim
            + candidates
            + invariants
            + self.rubric_chars
        )


DEFAULT_LIMITS = EvidenceLimits()


class GoldPointSource(Protocol):
    @property
    def key(self) -> str: ...

    @property
    def value(self) -> JsonValue: ...

    @property
    def rendered(self) -> str: ...


class InvariantSource(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def rule(self) -> str: ...


@dataclass(frozen=True, slots=True)
class EvidenceSource:
    ask: str | None
    answer: str | None
    gold_points: Sequence[GoldPointSource] = ()
    must_not_claim: Sequence[str] = ()
    invariants: Sequence[InvariantSource] = ()
    rubric: str = RUBRIC_TEXT


def redact_private_keys(text: str) -> str:
    return PRIVATE_KEY_BLOCK.sub(REDACTION, text)


def sensitive_assignment_spans(line: str) -> list[SpanMatch]:
    spans: list[SpanMatch] = []
    for token in NAME_TOKEN_START.finditer(line):
        found = SENSITIVE_ASSIGNMENT.match(line, token.start())
        if (
            found is not None
            and is_sensitive_name(found.group("name"))
            and looks_like_real_secret(found.group("secret"))
        ):
            spans.append(
                SpanMatch("high_entropy_assignment", found.start("secret"), found.end("secret"))
            )
    return spans


def redact_line(line: str) -> str:
    spans = merge_spans([*find_matches(line), *sensitive_assignment_spans(line)])
    if not spans:
        return line
    pieces: list[str] = []
    cursor = 0
    for start, end in spans:
        pieces.append(line[cursor:start])
        pieces.append(REDACTION)
        cursor = end
    pieces.append(line[cursor:])
    return "".join(pieces)


def redact_secrets(text: str) -> str:
    without_keys = redact_private_keys(text)
    return "\n".join(redact_line(line) for line in without_keys.split("\n"))


def redact_json(value: JsonValue) -> JsonValue:
    if isinstance(value, str):
        return redact_secrets(value)
    if isinstance(value, list):
        return [redact_json(item) for item in value]
    if isinstance(value, dict):
        return {key: redact_json(item) for key, item in value.items()}
    return value


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - len(TRUNCATION_MARKER))] + TRUNCATION_MARKER


def clean_text(text: str, limit: int) -> str:
    return clip(redact_secrets(text), limit)


def clean_optional(text: str | None, limit: int) -> str | None:
    return None if text is None else clean_text(text, limit)


def bounded_value(value: JsonValue, rendered: str, limit: int) -> JsonValue:
    redacted = redact_json(value)
    if len(json.dumps(redacted, ensure_ascii=False)) <= limit:
        return redacted
    return clip(rendered, limit)


def evidence_gold_point(source: GoldPointSource, limits: EvidenceLimits) -> EvidenceGoldPoint:
    rendered = clean_text(source.rendered, limits.gold_rendered_chars)
    return EvidenceGoldPoint(
        key=clean_text(source.key, limits.gold_key_chars),
        value=bounded_value(source.value, rendered, limits.gold_value_chars),
        rendered=rendered,
    )


def evidence_invariant(source: InvariantSource, limits: EvidenceLimits) -> EvidenceInvariant:
    return EvidenceInvariant(
        id=clean_text(source.id, limits.invariant_id_chars),
        rule=clean_text(source.rule, limits.invariant_rule_chars),
    )


def reference_text(ask: str | None, gold_points: Iterable[GoldPointSource]) -> str:
    parts = [ask or ""]
    for gold in gold_points:
        parts.append(gold.rendered)
        parts.append(json.dumps(gold.value, ensure_ascii=False))
    return "\n".join(parts).lower().replace(",", "")


def numeric_tokens(sentence: str) -> list[str]:
    return [token.replace(",", "").lower() for token in NUMERIC_TOKEN.findall(sentence)]


def has_unreferenced_number(sentence: str, reference: str) -> bool:
    return any(token not in reference for token in numeric_tokens(sentence))


def unsupported_claim_candidates(
    answer: str | None,
    ask: str | None,
    gold_points: Sequence[GoldPointSource],
    limits: EvidenceLimits,
) -> list[str]:
    if not answer or not gold_points:
        return []
    reference = reference_text(ask, gold_points)
    candidates: list[str] = []
    for sentence in SENTENCE_BOUNDARY.split(redact_secrets(answer)):
        stripped = sentence.strip()
        if stripped and has_unreferenced_number(stripped, reference):
            candidates.append(clip(stripped, limits.unsupported_candidate_chars))
    return list(dict.fromkeys(candidates))[: limits.unsupported_candidates]


def build_evidence(
    source: EvidenceSource, limits: EvidenceLimits = DEFAULT_LIMITS
) -> EvidenceBlock:
    candidates = unsupported_claim_candidates(source.answer, source.ask, source.gold_points, limits)
    block = EvidenceBlock(
        ask=clean_optional(source.ask, limits.ask_chars),
        answer=clean_optional(source.answer, limits.answer_chars),
        gold_points=[
            evidence_gold_point(gold, limits) for gold in source.gold_points[: limits.gold_points]
        ],
        must_not_claim=[
            clean_text(claim, limits.must_not_claim_chars)
            for claim in source.must_not_claim[: limits.must_not_claim_items]
        ],
        unsupported_claim_candidates=candidates,
        invariants=[
            evidence_invariant(invariant, limits)
            for invariant in source.invariants[: limits.invariants]
        ],
        rubric=clean_text(source.rubric, limits.rubric_chars),
    )
    log_dropped_items(source, limits)
    return block


def log_dropped_items(source: EvidenceSource, limits: EvidenceLimits) -> None:
    dropped = {
        "gold_points": max(0, len(source.gold_points) - limits.gold_points),
        "must_not_claim": max(0, len(source.must_not_claim) - limits.must_not_claim_items),
        "invariants": max(0, len(source.invariants) - limits.invariants),
    }
    if any(dropped.values()):
        logger.warning("evidence_items_dropped", extra={"dropped": dropped})


def has_reference(evidence: EvidenceBlock) -> bool:
    return bool(evidence.gold_points)


def evidence_size_chars(evidence: EvidenceBlock) -> int:
    return len(evidence.model_dump_json())
