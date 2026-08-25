import type { ErrorDetail, ErrorResponse, UserRole } from "../types";

export const STATUS_CODES: Record<number, string> = {
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
};

export class MockApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetail[];
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: ErrorDetail[] = [],
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export function unauthenticated(
  message = "Authentication required",
  code = "unauthenticated",
): MockApiError {
  return new MockApiError(401, code, message, [], { "WWW-Authenticate": "Bearer" });
}

export function forbidden(message = "Not allowed", code = "forbidden"): MockApiError {
  return new MockApiError(403, code, message);
}

export function roleRequired(
  minimum: UserRole,
  message = `Requires role ${minimum} or higher`,
): MockApiError {
  return new MockApiError(403, "role_required", message, [
    { loc: ["role"], code: minimum, message },
  ]);
}

export function teamBudgetExceeded(
  teamName: string,
  message = `Team ${teamName} would pass its monthly budget`,
): MockApiError {
  return new MockApiError(409, "team_budget_exceeded", message, [
    { loc: ["team"], code: "team_budget_exceeded", message: teamName },
  ]);
}

export function notFound(message = "Resource not found"): MockApiError {
  return new MockApiError(404, "not_found", message);
}

export function methodNotAllowed(allowed: string[]): MockApiError {
  return new MockApiError(405, "method_not_allowed", "Method Not Allowed", [], {
    Allow: allowed.join(", "),
  });
}

export function conflict(code: string, message: string, headers: Record<string, string> = {}) {
  return new MockApiError(409, code, message, [], headers);
}

export function idempotencyKeyRequired(): MockApiError {
  return new MockApiError(
    400,
    "idempotency_key_required",
    "A valid Idempotency-Key header of 8 to 128 printable characters is required",
  );
}

export function rateLimited(retryAfterSeconds: number): MockApiError {
  return new MockApiError(429, "rate_limited", "Too many failed attempts, try again later", [], {
    "Retry-After": String(retryAfterSeconds),
  });
}

export function dependencyUnavailable(dependency: string, message: string): MockApiError {
  return new MockApiError(503, "dependency_unavailable", message, [
    { loc: ["dependency"], code: dependency, message },
  ]);
}

export function validationFailed(details: ErrorDetail[]): MockApiError {
  return new MockApiError(422, "validation_failed", "Request validation failed", details);
}

export function internalError(): MockApiError {
  return new MockApiError(500, "internal_error", "Internal server error");
}

export function buildErrorBody(error: MockApiError, requestId: string): ErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      request_id: requestId,
      details: error.details,
    },
  };
}
