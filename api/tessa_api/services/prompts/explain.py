import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime

from pydantic import JsonValue

from tessa_api.schemas.common import format_timestamp
from tessa_api.services.grading_rules import clip_text
from tessa_api.services.prompt_composer import PromptCompositionError, render_template
from tessa_api.services.prompts.explain_text import (
    NO_ROOM,
    NOT_RECORDED,
    Masker,
    elide_middle,
    fence,
    fenced_within,
    joined_within,
    json_text,
    share_budget,
    value_block,
)

FINDING_ID = "FINDING_ID"
TARGET_TOKEN = "TARGET_TOKEN"
FINDING_TITLE = "FINDING_TITLE"
FINDING_CLASS = "FINDING_CLASS"
FINDING_SEVERITY = "FINDING_SEVERITY"
FINDING_STATUS = "FINDING_STATUS"
OCCURRENCE_COUNT = "OCCURRENCE_COUNT"
FIRST_SEEN = "FIRST_SEEN"
LAST_SEEN = "LAST_SEEN"
INVARIANT = "INVARIANT"
EXPECTED = "EXPECTED"
ACTUAL = "ACTUAL"
REPRO_FACTS = "REPRO_FACTS"
SCENARIO_YAML = "SCENARIO_YAML"
TRANSCRIPT = "TRANSCRIPT"
ORACLE_ROWS = "ORACLE_ROWS"

FLEXIBLE_SECTIONS = (TRANSCRIPT, SCENARIO_YAML, ORACLE_ROWS)
SECTION_WEIGHTS: Mapping[str, float] = {TRANSCRIPT: 0.5, SCENARIO_YAML: 0.3, ORACLE_ROWS: 0.2}
TITLE_LIMIT = 300
VALUE_LIMIT = 1500
INVARIANT_LIMIT = 500
FACT_LIMIT = 300
FAILING_FIELD_LIMIT = 2500
MIN_FAILING_FIELD_LIMIT = 200
FIELDS_PER_FAILING_STEP = 5
PASSING_LINE_LIMIT = 220
MAX_FIT_ROUNDS = 6
FIT_SLACK = 16
NO_REPRO_TEXT = (
    "No run recorded this finding, so there is no repro. Use the expected and actual values above."
)
NO_INVARIANT_TEXT = "No invariant is attached to this finding."
NO_TRANSCRIPT_TEXT = "No steps were recorded for this finding."
NO_ORACLE_TEXT = "The failing step read no database rows."
MIN_SECTION_CHARS = 120
FENCE_ALLOWANCE = 16


@dataclass(frozen=True, slots=True)
class ExplainStep:
    index: int
    label: str
    method: str | None
    address: str | None
    status_code: int | None
    latency_ms: int
    ok: bool | None
    failing: bool
    ask: str | None
    answer: str | None
    excerpt: str | None
    failures: tuple[str, ...]
    verdict: str | None


@dataclass(frozen=True, slots=True)
class ExplainInputs:
    finding_id: uuid.UUID
    target_token: str
    title: str
    finding_class: str
    severity: str
    status: str
    occurrence_count: int
    first_seen: datetime
    last_seen: datetime
    invariant_text: str | None
    expected: JsonValue
    actual: JsonValue
    repro_facts: tuple[str, ...]
    scenario_yaml: str | None
    steps: tuple[ExplainStep, ...]
    oracle_rows: tuple[Mapping[str, JsonValue], ...]


@dataclass(frozen=True, slots=True)
class ExplainRender:
    text: str
    masked_hits: int
    elided: bool


def masked_step(step: ExplainStep, masker: Masker) -> ExplainStep:
    return replace(
        step,
        label=masker.text(step.label),
        address=masker.optional(step.address),
        ask=masker.optional(step.ask),
        answer=masker.optional(step.answer),
        excerpt=masker.optional(step.excerpt),
        failures=tuple(masker.text(item) for item in step.failures),
        verdict=masker.optional(step.verdict),
    )


def masked_inputs(inputs: ExplainInputs, masker: Masker) -> ExplainInputs:
    return replace(
        inputs,
        title=masker.text(inputs.title),
        invariant_text=masker.optional(inputs.invariant_text),
        expected=masker.json(inputs.expected),
        actual=masker.json(inputs.actual),
        repro_facts=tuple(masker.text(fact) for fact in inputs.repro_facts),
        scenario_yaml=masker.optional(inputs.scenario_yaml),
        steps=tuple(masked_step(step, masker) for step in inputs.steps),
        oracle_rows=tuple(
            {key: masker.json(value) for key, value in row.items()} for row in inputs.oracle_rows
        ),
    )


def fixed_values(inputs: ExplainInputs) -> dict[str, str]:
    invariant = (
        NO_INVARIANT_TEXT
        if inputs.invariant_text is None
        else clip_text(inputs.invariant_text, INVARIANT_LIMIT)
    )
    facts = (
        NO_REPRO_TEXT
        if not inputs.repro_facts
        else "\n".join(clip_text(fact, FACT_LIMIT) for fact in inputs.repro_facts)
    )
    return {
        FINDING_ID: str(inputs.finding_id),
        TARGET_TOKEN: inputs.target_token,
        FINDING_TITLE: clip_text(inputs.title, TITLE_LIMIT),
        FINDING_CLASS: inputs.finding_class,
        FINDING_SEVERITY: inputs.severity,
        FINDING_STATUS: inputs.status,
        OCCURRENCE_COUNT: str(inputs.occurrence_count),
        FIRST_SEEN: format_timestamp(inputs.first_seen),
        LAST_SEEN: format_timestamp(inputs.last_seen),
        INVARIANT: invariant,
        EXPECTED: value_block(inputs.expected, VALUE_LIMIT),
        ACTUAL: value_block(inputs.actual, VALUE_LIMIT),
        REPRO_FACTS: facts,
    }


def request_text(step: ExplainStep) -> str | None:
    if step.method is None and step.address is None:
        return None
    return f"{step.method or ''} {step.address or ''}".strip()


def passing_line(step: ExplainStep) -> str:
    outcome = "ok" if step.ok is not False else "did not complete"
    request = request_text(step)
    where = "" if request is None else f" {request}"
    status = "" if step.status_code is None else f" -> {step.status_code}"
    line = f"- Step {step.index + 1} {outcome}: {step.label}{where}{status} ({step.latency_ms} ms)"
    return clip_text(line, PASSING_LINE_LIMIT)


def failing_block(step: ExplainStep, field_limit: int) -> str:
    lines = [f"### Step {step.index + 1} (failing): {clip_text(step.label, field_limit)}"]
    request = request_text(step)
    if request is not None:
        lines.append(f"Request: {clip_text(request, field_limit)}")
    status = "no response" if step.status_code is None else f"HTTP {step.status_code}"
    lines.append(f"Result: {status}, {step.latency_ms} ms, completed: {step.ok}")
    for title, value in (
        ("Asked", step.ask),
        ("Answer", step.answer),
        ("Response excerpt", step.excerpt),
    ):
        if value:
            lines.append(f"{title}:")
            lines.append(fenced_within(value, field_limit))
    if step.failures:
        lines.append("Failed checks:")
        lines.extend(f"- {clip_text(item, field_limit)}" for item in step.failures)
    if step.verdict:
        lines.append(f"Verdict: {clip_text(step.verdict, field_limit)}")
    return "\n".join(lines)


def failing_blocks_within(steps: Sequence[ExplainStep], limit: int) -> list[str]:
    field_limit = FAILING_FIELD_LIMIT
    while True:
        blocks = [failing_block(step, field_limit) for step in steps]
        total = sum(len(block) + 2 for block in blocks)
        if total <= limit or field_limit <= MIN_FAILING_FIELD_LIMIT:
            return blocks
        field_limit = max(MIN_FAILING_FIELD_LIMIT, field_limit // 2)


def distance_to_failure(index: int, failing_indexes: Sequence[int]) -> int:
    return min((abs(index - other) for other in failing_indexes), default=index)


def kept_passing_indexes(
    steps: Sequence[ExplainStep], failing_indexes: Sequence[int], limit: int
) -> set[int]:
    passing = [step for step in steps if not step.failing]
    ranked = sorted(
        passing, key=lambda step: (distance_to_failure(step.index, failing_indexes), step.index)
    )
    kept: set[int] = set()
    used = 0
    for step in ranked:
        cost = len(passing_line(step)) + 1
        if used + cost > limit:
            break
        kept.add(step.index)
        used += cost
    return kept


def omitted_marker(count: int) -> str:
    noun = "step" if count == 1 else "steps"
    return f"[... {count} passing {noun} omitted ...]"


def transcript_text(steps: Sequence[ExplainStep], limit: int) -> tuple[str, bool]:
    if not steps:
        return NO_TRANSCRIPT_TEXT, False
    if limit < MIN_SECTION_CHARS:
        return NO_ROOM, True
    failing = [step for step in steps if step.failing]
    failing_indexes = [step.index for step in failing]
    reserved = min(
        sum(len(passing_line(step)) + 1 for step in steps if not step.failing), limit // 5
    )
    blocks = dict(
        zip(
            failing_indexes,
            failing_blocks_within(failing, max(limit - reserved, 0)),
            strict=True,
        )
    )
    used = sum(len(block) + 2 for block in blocks.values())
    kept = kept_passing_indexes(steps, failing_indexes, max(limit - used, 0))
    parts: list[str] = []
    gap = 0
    for step in steps:
        if step.failing:
            parts.extend(flush_gap(gap))
            gap = 0
            parts.append(blocks[step.index])
        elif step.index in kept:
            parts.extend(flush_gap(gap))
            gap = 0
            parts.append(passing_line(step))
        else:
            gap += 1
    parts.extend(flush_gap(gap))
    text = "\n\n".join(parts)
    elided = len(kept) < sum(1 for step in steps if not step.failing) or len(text) > limit
    return elide_middle(text, limit) if len(text) > limit else text, elided


def flush_gap(gap: int) -> list[str]:
    return [omitted_marker(gap)] if gap else []


def oracle_text(rows: Sequence[Mapping[str, JsonValue]], limit: int) -> tuple[str, bool]:
    if not rows:
        return NO_ORACLE_TEXT, False
    if limit < MIN_SECTION_CHARS:
        return NO_ROOM, True
    lines = [" ".join(json_text(dict(row)).split()) for row in rows]
    shown, dropped = joined_within(
        lines, limit - FENCE_ALLOWANCE, lambda count: f"[... {count} more rows omitted ...]"
    )
    return fenced_within(shown, limit), dropped > 0


def scenario_text(text: str | None, limit: int) -> tuple[str, bool]:
    if text is None:
        return NOT_RECORDED, False
    block = fenced_within(text, limit, "yaml")
    return block, len(fence(text, "yaml")) > len(block)


def flexible_values(inputs: ExplainInputs, budget: int) -> tuple[dict[str, str], bool]:
    naturals = {
        TRANSCRIPT: len(transcript_text(inputs.steps, 10**9)[0]),
        SCENARIO_YAML: len(scenario_text(inputs.scenario_yaml, 10**9)[0]),
        ORACLE_ROWS: len(oracle_text(inputs.oracle_rows, 10**9)[0]),
    }
    shares = share_budget(naturals, SECTION_WEIGHTS, max(budget, 0))
    transcript, transcript_elided = transcript_text(inputs.steps, shares[TRANSCRIPT])
    scenario, scenario_elided = scenario_text(inputs.scenario_yaml, shares[SCENARIO_YAML])
    oracle, oracle_elided = oracle_text(inputs.oracle_rows, shares[ORACLE_ROWS])
    return (
        {TRANSCRIPT: transcript, SCENARIO_YAML: scenario, ORACLE_ROWS: oracle},
        transcript_elided or scenario_elided or oracle_elided,
    )


def empty_flexible() -> dict[str, str]:
    return dict.fromkeys(FLEXIBLE_SECTIONS, "")


def render_explain(template_text: str, inputs: ExplainInputs, max_chars: int) -> ExplainRender:
    masker = Masker()
    safe = masked_inputs(inputs, masker)
    fixed = fixed_values(safe)
    base = render_template(template_text, {**fixed, **empty_flexible()})
    if len(base) > max_chars:
        raise PromptCompositionError(
            f"TESSA_EXPLAIN_MAX_CHARS ({max_chars}) is smaller than the fixed part of the "
            f"Explain prompt ({len(base)} characters)"
        )
    budget = max_chars - len(base)
    for _ in range(MAX_FIT_ROUNDS):
        flexible, elided = flexible_values(safe, budget)
        text = render_template(template_text, {**fixed, **flexible})
        if len(text) <= max_chars:
            return finished(text, masker, elided, max_chars)
        budget -= len(text) - max_chars + FIT_SLACK
    raise PromptCompositionError("The Explain prompt could not be fitted under the size limit")


def finished(text: str, masker: Masker, elided: bool, max_chars: int) -> ExplainRender:
    final = masker.text(text)
    if len(final) > max_chars:
        final = elide_middle(final, max_chars)
        elided = True
    return ExplainRender(text=final, masked_hits=masker.hits, elided=elided)
