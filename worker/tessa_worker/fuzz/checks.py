import hashlib
from collections.abc import Mapping
from uuid import UUID

from pydantic import JsonValue

from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.steps import Tier0Failure
from tessa_api.schemas.temporal import FuzzFailure
from tessa_api.services.grading_rules import clip_text
from tessa_worker.adapters.redact import Redactor
from tessa_worker.fuzz.models import CollectedFailure
from tessa_worker.fuzz.redaction import safe_message

NOT_A_SERVER_ERROR = "not_a_server_error"
STATUS_CODE_CONFORMANCE = "status_code_conformance"
CONTENT_TYPE_CONFORMANCE = "content_type_conformance"
RESPONSE_HEADERS_CONFORMANCE = "response_headers_conformance"
RESPONSE_SCHEMA_CONFORMANCE = "response_schema_conformance"

CONTRACT_CHECKS = (
    STATUS_CODE_CONFORMANCE,
    CONTENT_TYPE_CONFORMANCE,
    RESPONSE_HEADERS_CONFORMANCE,
    RESPONSE_SCHEMA_CONFORMANCE,
)
FUZZ_CHECKS = (NOT_A_SERVER_ERROR, *CONTRACT_CHECKS)

SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
SERVER_ERROR_EXPECTATION = "a response status below 500"
CHECK_EXPECTATIONS: Mapping[str, str] = {
    STATUS_CODE_CONFORMANCE: "a response status the OpenAPI document declares",
    CONTENT_TYPE_CONFORMANCE: "a response content type the OpenAPI document declares",
    RESPONSE_HEADERS_CONFORMANCE: "response headers that match the OpenAPI document",
    RESPONSE_SCHEMA_CONFORMANCE: "a response body that matches the OpenAPI schema",
}
MESSAGE_LIMIT = 300
SEED_BITS = 48


def derive_seed(run_id: UUID, role: str) -> int:
    digest = hashlib.sha256(f"{run_id}:{role}".encode()).digest()
    return int.from_bytes(digest[: SEED_BITS // 8], "big")


def is_server_error_check(check: str) -> bool:
    return check == NOT_A_SERVER_ERROR


def tier0_check_of(check: str) -> Tier0Check:
    return Tier0Check.status if is_server_error_check(check) else Tier0Check.schema


def stable_message(failure: CollectedFailure) -> str:
    if is_server_error_check(failure.check):
        return f"{failure.operation}: {failure.title}"
    return f"{failure.operation}: {failure.check}: {failure.title}"


def tier0_failure_of(failure: CollectedFailure, redactor: Redactor) -> Tier0Failure:
    expected: JsonValue
    actual: JsonValue
    if is_server_error_check(failure.check):
        expected = SERVER_ERROR_EXPECTATION
        actual = None if failure.response is None else failure.response.status_code
    else:
        expected = CHECK_EXPECTATIONS.get(failure.check, failure.check)
        actual = safe_message(failure.message, redactor, MESSAGE_LIMIT)
    return Tier0Failure(
        check=tier0_check_of(failure.check),
        message=stable_message(failure),
        expected=expected,
        actual=actual,
    )


def fuzz_failure_of(failure: CollectedFailure, redactor: Redactor, seed: int) -> FuzzFailure:
    return FuzzFailure(
        operation=failure.operation,
        check=failure.check,
        message=clip_text(
            safe_message(f"{failure.title}: {failure.message}", redactor, MESSAGE_LIMIT),
            MESSAGE_LIMIT,
        ),
        status_code=None if failure.response is None else failure.response.status_code,
        case_seed=seed,
    )
