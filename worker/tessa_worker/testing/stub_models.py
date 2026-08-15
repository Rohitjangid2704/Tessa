from collections.abc import Callable, Mapping
from dataclasses import dataclass

from pydantic import BaseModel

from tessa_api.schemas.enums import ModelRole
from tessa_api.schemas.grading import JudgeStepInput, ModelCallSpec
from tessa_api.settings import StrictSettings
from tessa_worker.grading.judge_models import JudgeAnswer, JudgeLabel
from tessa_worker.grading.stub_markers import STUB_MODEL_ID, STUB_REASON_CODE

__all__ = [
    "STUB_MODEL_ID",
    "STUB_REASON_CODE",
    "StubCall",
    "StubHandler",
    "StubModelRegistry",
    "StubModelsRefusedError",
    "StubRoleNotRegisteredError",
    "canned_judge_answer",
    "default_stub_registry",
    "ensure_stub_models_allowed",
]

PROD_ENV = "prod"

STUB_PASS_CONFIDENCE = 0.9
STUB_FAIL_CONFIDENCE = 0.9
STUB_UNCERTAIN_CONFIDENCE = 0.5


class StubModelsRefusedError(RuntimeError):
    pass


class StubRoleNotRegisteredError(LookupError):
    pass


@dataclass(frozen=True, slots=True)
class StubCall:
    role: ModelRole
    spec: ModelCallSpec
    payload: BaseModel


StubHandler = Callable[[StubCall], str]


class StubModelRegistry:
    def __init__(self, handlers: Mapping[ModelRole, StubHandler] | None = None) -> None:
        self.handlers: dict[ModelRole, StubHandler] = dict(handlers or {})

    def register(self, role: ModelRole, handler: StubHandler) -> None:
        if role in self.handlers:
            raise ValueError(f"a stub for role {role.value} is already registered")
        self.handlers[role] = handler

    def replace(self, role: ModelRole, handler: StubHandler) -> None:
        self.handlers[role] = handler

    def registered_roles(self) -> frozenset[ModelRole]:
        return frozenset(self.handlers)

    def reply(self, call: StubCall) -> str:
        handler = self.handlers.get(call.role)
        if handler is None:
            raise StubRoleNotRegisteredError(f"no stub is registered for role {call.role.value}")
        return handler(call)


def ensure_stub_models_allowed(settings: StrictSettings) -> None:
    if settings.stub_models and settings.env == PROD_ENV:
        raise StubModelsRefusedError("TESSA_STUB_MODELS must be false when TESSA_ENV=prod")


def stub_answer(
    verdict: JudgeLabel,
    confidence: float,
    rationale: str,
    gold_keys: list[str],
    forbidden: list[int],
) -> str:
    answer = JudgeAnswer(
        verdict=verdict,
        confidence=confidence,
        rationale=rationale,
        gold_points_used=gold_keys,
        must_not_claim_found=forbidden,
        unsupported_claims=[],
    )
    return answer.model_dump_json()


def canned_judge_answer(call: StubCall) -> str:
    if not isinstance(call.payload, JudgeStepInput):
        raise TypeError("the judge stub answers JudgeStepInput only")
    evidence = call.payload.evidence
    answer_text = (evidence.answer or "").strip().lower()
    forbidden = [
        index
        for index, claim in enumerate(evidence.must_not_claim)
        if claim.strip().lower() in answer_text
    ]
    gold_keys = [gold.key for gold in evidence.gold_points]
    if not answer_text:
        return stub_answer(
            "uncertain", STUB_UNCERTAIN_CONFIDENCE, "Stub: the answer is empty.", [], []
        )
    if forbidden:
        return stub_answer(
            "fail",
            STUB_FAIL_CONFIDENCE,
            "Stub: the answer asserts a forbidden claim.",
            [],
            forbidden,
        )
    if not evidence.gold_points:
        return stub_answer(
            "uncertain",
            STUB_UNCERTAIN_CONFIDENCE,
            "Stub: there is no reference to judge against.",
            [],
            [],
        )
    missing = [
        gold.key
        for gold in evidence.gold_points
        if gold.rendered.strip().lower() not in answer_text
    ]
    if missing:
        return stub_answer(
            "fail", STUB_FAIL_CONFIDENCE, "Stub: the answer misses a gold point.", gold_keys, []
        )
    if evidence.unsupported_claim_candidates:
        return stub_answer(
            "uncertain",
            STUB_UNCERTAIN_CONFIDENCE,
            "Stub: the answer holds claims no gold point supports.",
            gold_keys,
            [],
        )
    return stub_answer(
        "pass", STUB_PASS_CONFIDENCE, "Stub: every gold point is stated.", gold_keys, []
    )


def default_stub_registry() -> StubModelRegistry:
    registry = StubModelRegistry()
    registry.register(ModelRole.judge, canned_judge_answer)
    registry.register(ModelRole.judge_tiebreak, canned_judge_answer)
    return registry
