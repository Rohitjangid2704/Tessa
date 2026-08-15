import asyncio
import math
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from tessa_api.schemas.enums import ProbeAnswerType, ProbeStatus
from tessa_api.services.probe_specs import ProbeSpec, render_probe_state

SYSTEMONE_PATH = "/v1/systemone"
NOUL_YES_FROM = 0.5
YES_ANSWER = "yes"
NO_ANSWER = "no"
ATTEMPTS = 2
RETRYABLE_STATUS_CODES = frozenset({500, 502, 503, 504})
RETRY_DELAY_SECONDS = 0.25
MAX_RETRY_AFTER_SECONDS = 2.0
MAX_QUESTIONS_PER_CALL = 32
MAX_CHOICE_STATE_CHARS = 1200


class LayaReason(StrEnum):
    decided = "decided"
    below_threshold = "below_threshold"
    too_long = "too_long"
    outside_allow_list = "outside_allow_list"
    missing_input = "missing_input"
    truncated_by_laya = "truncated_by_laya"
    timeout = "timeout"
    transport_error = "transport_error"
    http_error = "http_error"
    parse_error = "parse_error"
    deadline_exceeded = "deadline_exceeded"


class LayaDecision(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: ProbeStatus
    answer: str | None
    confidence: float
    threshold: float
    latency_ms: int
    reason: LayaReason


@dataclass(frozen=True, slots=True)
class ProbeRequest:
    probe: ProbeSpec
    fields: Mapping[str, str]
    threshold: float


@dataclass(frozen=True, slots=True)
class ChoiceRequest:
    question_id: str
    state: str
    instructions: str
    options: tuple[str, ...]
    threshold: float


@dataclass(frozen=True, slots=True)
class PreparedProbe:
    index: int
    request: ProbeRequest

    @property
    def question_id(self) -> str:
        return self.request.probe.id


@dataclass(frozen=True, slots=True)
class LayaResponse:
    payload: Mapping[str, Any]
    latency_ms: int


class LayaCallFailure(Exception):
    def __init__(self, reason: LayaReason) -> None:
        super().__init__(reason.value)
        self.reason = reason


def elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


def refused_at(threshold: float, reason: LayaReason) -> LayaDecision:
    return LayaDecision(
        status=ProbeStatus.uncertain,
        answer=None,
        confidence=0.0,
        threshold=threshold,
        latency_ms=0,
        reason=reason,
    )


def failed_at(threshold: float, reason: LayaReason, latency_ms: int) -> LayaDecision:
    return LayaDecision(
        status=ProbeStatus.error,
        answer=None,
        confidence=0.0,
        threshold=threshold,
        latency_ms=latency_ms,
        reason=reason,
    )


def refused(request: ProbeRequest, reason: LayaReason) -> LayaDecision:
    return refused_at(request.threshold, reason)


def failed(request: ProbeRequest, reason: LayaReason, latency_ms: int) -> LayaDecision:
    return failed_at(request.threshold, reason, latency_ms)


def input_refusal(request: ProbeRequest) -> LayaReason | None:
    limits = {spec.name.value: spec.max_chars for spec in request.probe.input.fields}
    if any(name not in limits for name in request.fields):
        return LayaReason.outside_allow_list
    if any(not request.fields.get(name, "").strip() for name in limits):
        return LayaReason.missing_input
    if any(len(request.fields[name]) > max_chars for name, max_chars in limits.items()):
        return LayaReason.too_long
    return None


def render_state(request: ProbeRequest) -> str:
    return render_probe_state(request.probe, request.fields)


def build_question(probe: ProbeSpec) -> dict[str, Any]:
    if probe.answer_type is ProbeAnswerType.yes_no:
        return {"type": "noul", "instructions": probe.question}
    return {"type": "choice", "instructions": probe.question, "criteria": list(probe.choices)}


def build_body(state: str, members: Sequence[PreparedProbe]) -> dict[str, Any]:
    return {
        "state": state,
        "questions": {
            member.question_id: build_question(member.request.probe) for member in members
        },
    }


def read_probability(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        return None
    return float(value)


def parse_noul(entry: Mapping[str, Any]) -> tuple[str, float] | None:
    probability_yes = read_probability(entry.get("noul"))
    if probability_yes is None:
        return None
    answer = YES_ANSWER if probability_yes >= NOUL_YES_FROM else NO_ANSWER
    reported = read_probability(entry.get("answer_confidence"))
    return answer, reported if reported is not None else max(probability_yes, 1 - probability_yes)


def parse_choice(probe: ProbeSpec, entry: Mapping[str, Any]) -> tuple[str, float] | None:
    return parse_choice_among(probe.choices, entry)


def parse_choice_among(
    choices: Sequence[str], entry: Mapping[str, Any]
) -> tuple[str, float] | None:
    chosen = entry.get("choice")
    if not isinstance(chosen, str) or chosen not in choices:
        return None
    reported = read_probability(entry.get("answer_confidence"))
    if reported is None:
        probabilities = entry.get("probabilities")
        values = probabilities.values() if isinstance(probabilities, dict) else ()
        candidates = [read_probability(value) for value in values]
        known = [value for value in candidates if value is not None]
        reported = max(known) if known else None
    return None if reported is None else (chosen, reported)


def parse_answer(
    probe: ProbeSpec, payload: Mapping[str, Any], question_id: str
) -> tuple[str, float] | None:
    answers = payload.get("answers")
    entry = answers.get(question_id) if isinstance(answers, dict) else None
    if not isinstance(entry, dict):
        return None
    if probe.answer_type is ProbeAnswerType.yes_no:
        return parse_noul(entry)
    return parse_choice(probe, entry)


def question_ids(value: Any) -> set[str]:
    if isinstance(value, dict):
        return {str(key) for key in value}
    if isinstance(value, list):
        return {str(item) for item in value}
    return set()


def laya_truncated_input(payload: Mapping[str, Any], question_id: str) -> bool:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return False
    if question_id in question_ids(usage.get("options")):
        return True
    if usage.get("truncated") is not True:
        return False
    listed = question_ids(usage.get("truncated_questions"))
    return not listed or question_id in listed


def decision_from_response(prepared: PreparedProbe, response: LayaResponse) -> LayaDecision:
    request = prepared.request
    parsed = parse_answer(request.probe, response.payload, prepared.question_id)
    if parsed is None:
        return failed(request, LayaReason.parse_error, response.latency_ms)
    answer, confidence = parsed
    if laya_truncated_input(response.payload, prepared.question_id):
        status, reason = ProbeStatus.uncertain, LayaReason.truncated_by_laya
    elif confidence >= request.threshold:
        status, reason = ProbeStatus.decided, LayaReason.decided
    else:
        status, reason = ProbeStatus.uncertain, LayaReason.below_threshold
    return LayaDecision(
        status=status,
        answer=answer,
        confidence=confidence,
        threshold=request.threshold,
        latency_ms=response.latency_ms,
        reason=reason,
    )


def choice_refusal(request: ChoiceRequest) -> LayaReason | None:
    if not request.state.strip():
        return LayaReason.missing_input
    if len(request.state) > MAX_CHOICE_STATE_CHARS:
        return LayaReason.too_long
    return None


def choice_body(request: ChoiceRequest) -> dict[str, Any]:
    return {
        "state": request.state,
        "questions": {
            request.question_id: {
                "type": "choice",
                "instructions": request.instructions,
                "criteria": list(request.options),
            }
        },
    }


def choice_decision(request: ChoiceRequest, response: LayaResponse) -> LayaDecision:
    answers = response.payload.get("answers")
    entry = answers.get(request.question_id) if isinstance(answers, dict) else None
    parsed = parse_choice_among(request.options, entry) if isinstance(entry, dict) else None
    if parsed is None:
        return failed_at(request.threshold, LayaReason.parse_error, response.latency_ms)
    answer, confidence = parsed
    if laya_truncated_input(response.payload, request.question_id):
        status, reason = ProbeStatus.uncertain, LayaReason.truncated_by_laya
    elif confidence >= request.threshold:
        status, reason = ProbeStatus.decided, LayaReason.decided
    else:
        status, reason = ProbeStatus.uncertain, LayaReason.below_threshold
    return LayaDecision(
        status=status,
        answer=answer,
        confidence=confidence,
        threshold=request.threshold,
        latency_ms=response.latency_ms,
        reason=reason,
    )


def retry_delay(response: httpx.Response | None) -> float:
    if response is None:
        return RETRY_DELAY_SECONDS
    try:
        requested = float(response.headers.get("Retry-After", ""))
    except ValueError:
        return RETRY_DELAY_SECONDS
    return min(max(requested, 0.0), MAX_RETRY_AFTER_SECONDS)


def remaining_seconds(deadline: float | None) -> float:
    return math.inf if deadline is None else deadline - time.monotonic()


def decode_payload(response: httpx.Response, latency_ms: int) -> LayaResponse:
    try:
        payload = response.json()
    except ValueError:
        raise LayaCallFailure(LayaReason.parse_error) from None
    if not isinstance(payload, dict):
        raise LayaCallFailure(LayaReason.parse_error)
    return LayaResponse(payload=payload, latency_ms=latency_ms)


class LayaClient:
    def __init__(self, http: httpx.AsyncClient, base_url: str, timeout_seconds: float) -> None:
        self.http = http
        self.url = f"{base_url.rstrip('/')}{SYSTEMONE_PATH}"
        self.timeout_seconds = timeout_seconds

    async def decide(
        self, requests: Sequence[ProbeRequest], deadline: float | None = None
    ) -> list[LayaDecision]:
        decisions: dict[int, LayaDecision] = {}
        groups: dict[str, list[PreparedProbe]] = {}
        for index, request in enumerate(requests):
            refusal = input_refusal(request)
            if refusal is not None:
                decisions[index] = refused(request, refusal)
            else:
                groups.setdefault(render_state(request), []).append(PreparedProbe(index, request))
        for state, members in groups.items():
            for start in range(0, len(members), MAX_QUESTIONS_PER_CALL):
                chunk = members[start : start + MAX_QUESTIONS_PER_CALL]
                decisions.update(await self.decide_chunk(state, chunk, deadline))
        return [decisions[index] for index in range(len(requests))]

    async def choose(
        self, requests: Sequence[ChoiceRequest], deadline: float | None = None
    ) -> list[LayaDecision]:
        return [await self.choose_one(request, deadline) for request in requests]

    async def choose_one(self, request: ChoiceRequest, deadline: float | None) -> LayaDecision:
        refusal = choice_refusal(request)
        if refusal is not None:
            return refused_at(request.threshold, refusal)
        started = time.perf_counter()
        try:
            response = await self.post(choice_body(request), deadline)
        except LayaCallFailure as failure:
            return failed_at(request.threshold, failure.reason, elapsed_ms(started))
        return choice_decision(request, response)

    async def decide_chunk(
        self, state: str, members: Sequence[PreparedProbe], deadline: float | None
    ) -> dict[int, LayaDecision]:
        started = time.perf_counter()
        try:
            response = await self.post(build_body(state, members), deadline)
        except LayaCallFailure as failure:
            latency_ms = elapsed_ms(started)
            return {
                member.index: failed(member.request, failure.reason, latency_ms)
                for member in members
            }
        return {member.index: decision_from_response(member, response) for member in members}

    async def post(self, body: dict[str, Any], deadline: float | None) -> LayaResponse:
        reason = LayaReason.transport_error
        for attempt in range(ATTEMPTS):
            timeout = min(self.timeout_seconds, remaining_seconds(deadline))
            if timeout <= 0:
                raise LayaCallFailure(LayaReason.deadline_exceeded)
            delay = RETRY_DELAY_SECONDS
            started = time.perf_counter()
            try:
                async with asyncio.timeout(timeout):
                    response = await self.http.post(self.url, json=body, timeout=timeout)
            except (TimeoutError, httpx.TimeoutException):
                reason = LayaReason.timeout
            except httpx.HTTPError:
                reason = LayaReason.transport_error
            else:
                if response.status_code == httpx.codes.OK:
                    return decode_payload(response, elapsed_ms(started))
                if response.status_code not in RETRYABLE_STATUS_CODES:
                    raise LayaCallFailure(LayaReason.http_error)
                reason = LayaReason.http_error
                delay = retry_delay(response)
            if attempt + 1 < ATTEMPTS:
                await asyncio.sleep(min(delay, max(remaining_seconds(deadline), 0.0)))
        raise LayaCallFailure(reason)
