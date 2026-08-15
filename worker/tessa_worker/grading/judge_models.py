import math
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator

from tessa_api.schemas.grading import ModelCallSpec
from tessa_worker.grading.errors import GradingErrorType
from tessa_worker.grading.pricing import TokenUsage

MAX_RATIONALE_CHARS = 1200
MAX_REFERENCE_ITEMS = 50
MAX_REFERENCE_KEY_CHARS = 120
MAX_UNSUPPORTED_CLAIMS = 10
MAX_CLAIM_CHARS = 300
STRUCTURED_OUTPUT_NAME = "judge_answer"

JudgeLabel = Literal["pass", "fail", "uncertain"]


class JudgeOutputInvalidError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class JudgeAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    verdict: JudgeLabel
    confidence: float
    rationale: str
    gold_points_used: list[str]
    must_not_claim_found: list[int]
    unsupported_claims: list[str]

    @field_validator("confidence")
    @classmethod
    def confidence_is_a_probability(cls, value: float) -> float:
        if math.isnan(value) or not 0.0 <= value <= 1.0:
            raise ValueError("confidence must be between 0 and 1")
        return value

    @field_validator("rationale")
    @classmethod
    def rationale_is_short_and_present(cls, value: str) -> str:
        if not value.strip() or len(value) > MAX_RATIONALE_CHARS:
            raise ValueError("rationale must be a short, non-empty text")
        return value

    @field_validator("gold_points_used")
    @classmethod
    def gold_point_keys_are_bounded(cls, value: list[str]) -> list[str]:
        if len(value) > MAX_REFERENCE_ITEMS or any(
            len(key) > MAX_REFERENCE_KEY_CHARS for key in value
        ):
            raise ValueError("too many or too long gold point keys")
        return value

    @field_validator("must_not_claim_found")
    @classmethod
    def claim_indexes_are_bounded(cls, value: list[int]) -> list[int]:
        if len(value) > MAX_REFERENCE_ITEMS or any(index < 0 for index in value):
            raise ValueError("too many or negative must-not-claim indexes")
        return value

    @field_validator("unsupported_claims")
    @classmethod
    def unsupported_claims_are_bounded(cls, value: list[str]) -> list[str]:
        if len(value) > MAX_UNSUPPORTED_CLAIMS or any(
            len(claim) > MAX_CLAIM_CHARS for claim in value
        ):
            raise ValueError("too many or too long unsupported claims")
        return value


def judge_answer_schema() -> dict[str, Any]:
    return JudgeAnswer.model_json_schema()


JUDGE_ANSWER_SCHEMA = judge_answer_schema()


def parse_judge_answer(text: str) -> JudgeAnswer:
    try:
        return JudgeAnswer.model_validate_json(text)
    except ValidationError as error:
        first = error.errors(include_input=False, include_url=False)[0]
        location = ".".join(str(part) for part in first["loc"]) or "root"
        raise JudgeOutputInvalidError(
            f"{error.error_count()} schema errors, first at {location}: {first['type']}"
        ) from None


@dataclass(frozen=True, slots=True)
class JudgeRequest:
    spec: ModelCallSpec
    instructions: str
    input_text: str
    timeout_seconds: float


@dataclass(frozen=True, slots=True)
class ProviderReply:
    text: str | None
    usage: TokenUsage | None
    incomplete: bool = False
    refused: bool = False


class JudgeProvider(Protocol):
    async def judge(self, request: JudgeRequest) -> ProviderReply: ...


class ProviderCallError(Exception):
    def __init__(self, kind: GradingErrorType, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


RETRYABLE_STATUS_CODES = frozenset({408, 409, 429})
SERVER_ERROR_FLOOR = 500


def unavailable_error(provider: str, what: str) -> ProviderCallError:
    return ProviderCallError(GradingErrorType.provider_unavailable, f"{provider} {what}", True)


def status_error(
    provider: str, status_code: int, quota_exhausted: bool = False
) -> ProviderCallError:
    retryable = not quota_exhausted and (
        status_code in RETRYABLE_STATUS_CODES or status_code >= SERVER_ERROR_FLOOR
    )
    kind = (
        GradingErrorType.provider_unavailable if retryable else GradingErrorType.provider_rejected
    )
    return ProviderCallError(kind, f"{provider} answered status {status_code}", retryable)
