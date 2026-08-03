from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import InterfaceError, OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response

from tessa_api.logging_config import current_request_id
from tessa_api.schemas.common import ErrorBody, ErrorDetail, ErrorResponse

STATUS_CODES: dict[int, str] = {
    400: "bad_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "validation_failed",
    429: "rate_limited",
    500: "internal_error",
    501: "not_implemented",
    502: "upstream_error",
    503: "dependency_unavailable",
}

STATUS_DESCRIPTIONS: dict[int, str] = {
    400: "Bad request",
    401: "Missing, invalid or expired credentials",
    403: "Authenticated but not allowed",
    404: "Resource not found",
    409: "Conflict with the current state",
    413: "Payload too large",
    415: "Unsupported media type",
    422: "Request validation failed",
    429: "Rate limited",
    500: "Unhandled server error",
    501: "Not implemented yet",
    502: "Upstream error",
    503: "A dependency is unavailable",
}


class ApiError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: Sequence[ErrorDetail] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = list(details or [])
        self.headers = dict(headers or {})


class IdempotentReplay(Exception):
    def __init__(self, status_code: int, body: Any) -> None:
        super().__init__("idempotent replay")
        self.status_code = status_code
        self.body = body


def unauthenticated(
    message: str = "Authentication required", code: str = "unauthenticated"
) -> ApiError:
    return ApiError(401, code, message, headers={"WWW-Authenticate": "Bearer"})


def forbidden(message: str = "Not allowed", code: str = "forbidden") -> ApiError:
    return ApiError(403, code, message)


def not_found(message: str = "Resource not found") -> ApiError:
    return ApiError(404, "not_found", message)


def not_implemented(message: str = "This endpoint is not implemented yet") -> ApiError:
    return ApiError(501, "not_implemented", message)


def dependency_unavailable(dependency: str, message: str) -> ApiError:
    detail = ErrorDetail(loc=["dependency"], code=dependency, message=message)
    return ApiError(503, "dependency_unavailable", message, [detail])


def error_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    return {
        status: {"model": ErrorResponse, "description": STATUS_DESCRIPTIONS[status]}
        for status in statuses
    }


def json_error_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    schema = {"$ref": f"#/components/schemas/{ErrorResponse.__name__}"}
    return {
        status: {
            "description": STATUS_DESCRIPTIONS[status],
            "content": {"application/json": {"schema": schema}},
        }
        for status in statuses
    }


def error_response(
    status_code: int,
    code: str,
    message: str,
    details: Sequence[ErrorDetail] = (),
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    body = ErrorResponse(
        error=ErrorBody(
            code=code,
            message=message,
            request_id=current_request_id(),
            details=list(details),
        )
    )
    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(mode="json"),
        headers=dict(headers or {}),
    )


def internal_error_response() -> JSONResponse:
    return error_response(500, "internal_error", "Internal server error")


async def handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
    return error_response(exc.status_code, exc.code, exc.message, exc.details, exc.headers)


async def handle_idempotent_replay(request: Request, exc: IdempotentReplay) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=exc.body,
        headers={"Idempotency-Replayed": "true"},
    )


def is_idempotency_key_error(error: Mapping[str, Any]) -> bool:
    location = [str(part).lower() for part in error["loc"]]
    return location == ["header", "idempotency-key"]


async def handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = exc.errors()
    if any(is_idempotency_key_error(error) for error in errors):
        return error_response(
            400,
            "idempotency_key_required",
            "A valid Idempotency-Key header of 8 to 128 printable characters is required",
        )
    details = [
        ErrorDetail(loc=list(error["loc"]), code=str(error["type"]), message=str(error["msg"]))
        for error in errors
    ]
    return error_response(422, "validation_failed", "Request validation failed", details)


async def handle_http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = STATUS_CODES.get(
        exc.status_code, "bad_request" if exc.status_code < 500 else "internal_error"
    )
    message = exc.detail if isinstance(exc.detail, str) and exc.detail else "Request failed"
    return error_response(exc.status_code, code, message, headers=exc.headers)


async def handle_database_unreachable(request: Request, exc: Exception) -> JSONResponse:
    error = dependency_unavailable("db", "Database is unavailable")
    return error_response(error.status_code, error.code, error.message, error.details)


def register_handler[E: Exception](
    app: FastAPI,
    exception_type: type[E],
    handler: Callable[[Request, E], Awaitable[Response]],
) -> None:
    async def adapter(request: Request, exc: Exception) -> Response:
        return await handler(request, cast(E, exc))

    app.add_exception_handler(exception_type, adapter)


def register_exception_handlers(app: FastAPI) -> None:
    register_handler(app, ApiError, handle_api_error)
    register_handler(app, ConnectionError, handle_database_unreachable)
    register_handler(app, OperationalError, handle_database_unreachable)
    register_handler(app, InterfaceError, handle_database_unreachable)
    register_handler(app, IdempotentReplay, handle_idempotent_replay)
    register_handler(app, RequestValidationError, handle_validation_error)
    register_handler(app, StarletteHTTPException, handle_http_exception)
