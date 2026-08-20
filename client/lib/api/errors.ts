import { z } from "zod";
import type { UserRole } from "@/lib/auth/schemas";
import type { components } from "./schema";

export const errorDetailSchema = z.object({
  loc: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
  message: z.string(),
}) satisfies z.ZodType<components["schemas"]["ErrorDetail"]>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    request_id: z.string(),
    details: z.array(errorDetailSchema),
  }),
}) satisfies z.ZodType<components["schemas"]["ErrorResponse"]>;

const fastApiDefaultBodySchema = z.object({
  detail: z.union([z.string(), z.array(z.object({ msg: z.string().optional() }).loose())]),
});

export type ApiErrorDetail = z.infer<typeof errorDetailSchema>;

export const DEPENDENCY_NAMES = ["temporal", "db", "laya", "storage"] as const;

export type DependencyName = (typeof DEPENDENCY_NAMES)[number];

export const NETWORK_ERROR_CODE = "network_error";

export const TOKEN_UNAVAILABLE_CODE = "token_unavailable";

export const ROLE_REQUIRED_CODE = "role_required";

export const TEAM_BUDGET_EXCEEDED_CODE = "team_budget_exceeded";

const ROLE_DETAIL_KEY = "role";
const TEAM_DETAIL_KEY = "team";
const ROLE_NAMES: readonly UserRole[] = ["viewer", "member", "admin"];
const ROLE_PATTERN = /\b(viewer|member|admin)\b/i;

const NUMERIC_SECONDS = /^\d+(?:\.\d+)?$/;
const HTTP_DATE_PREFIX = /^[A-Za-z]{3,9},/;

const FALLBACK_CODES: Record<number, string> = {
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
  502: "upstream_error",
  503: "dependency_unavailable",
};

const DEPENDENCY_UNAVAILABLE_MESSAGES: Record<DependencyName, string> = {
  temporal: "Temporal is not running",
  db: "The database is unreachable",
  laya: "Laya is not reachable",
  storage: "Storage is unavailable",
};

export type ApiErrorInit = {
  status: number;
  code: string;
  message: string;
  requestId?: string | null;
  details?: readonly ApiErrorDetail[];
  retryAfterSeconds?: number | null;
  cause?: unknown;
};

function isDependencyName(value: string): value is DependencyName {
  return (DEPENDENCY_NAMES as readonly string[]).includes(value);
}

function fallbackCode(status: number): string {
  return FALLBACK_CODES[status] ?? (status >= 500 ? "internal_error" : "bad_request");
}

function roleNamedIn(text: string | undefined): UserRole | null {
  const word = text?.match(ROLE_PATTERN)?.[1]?.toLowerCase();
  return ROLE_NAMES.find((role) => role === word) ?? null;
}

export function parseRetryAfterSeconds(
  value: string | null,
  now: number = Date.now(),
): number | null {
  const trimmed = value?.trim() ?? "";
  if (NUMERIC_SECONDS.test(trimmed)) {
    return Math.ceil(Number(trimmed));
  }
  if (!HTTP_DATE_PREFIX.test(trimmed)) {
    return null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  return Math.max(0, Math.ceil((dateMs - now) / 1000));
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: readonly ApiErrorDetail[];
  readonly retryAfterSeconds: number | null;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId && init.requestId.length > 0 ? init.requestId : null;
    this.details = init.details ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }

  get dependency(): DependencyName | null {
    if (this.status !== 503 || this.code !== "dependency_unavailable") {
      return null;
    }
    const name = this.details[0]?.code;
    return name !== undefined && isDependencyName(name) ? name : null;
  }

  get isRoleRequired(): boolean {
    return this.status === 403 && this.code === ROLE_REQUIRED_CODE;
  }

  get requiredRole(): UserRole | null {
    if (!this.isRoleRequired) {
      return null;
    }
    const detail = this.details.find((entry) => entry.loc[0] === ROLE_DETAIL_KEY);
    return roleNamedIn(detail?.code) ?? roleNamedIn(detail?.message) ?? roleNamedIn(this.message);
  }

  get isTeamBudgetExceeded(): boolean {
    return this.status === 409 && this.code === TEAM_BUDGET_EXCEEDED_CODE;
  }

  get budgetTeamName(): string | null {
    if (!this.isTeamBudgetExceeded) {
      return null;
    }
    const name = this.details.find((entry) => entry.loc[0] === TEAM_DETAIL_KEY)?.message.trim();
    return name ? name : null;
  }

  get isNetworkError(): boolean {
    return this.code === NETWORK_ERROR_CODE;
  }

  get isServerError(): boolean {
    return this.status >= 500;
  }

  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  static fromResponse(response: Response, body: unknown): ApiError {
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
    const headerRequestId = response.headers.get("x-request-id");

    const contractBody = errorResponseSchema.safeParse(body);
    if (contractBody.success) {
      const { error } = contractBody.data;
      return new ApiError({
        status: response.status,
        code: error.code,
        message: error.message,
        requestId: error.request_id || headerRequestId,
        details: error.details,
        retryAfterSeconds,
      });
    }

    const defaultBody = fastApiDefaultBodySchema.safeParse(body);
    const detail = defaultBody.success ? defaultBody.data.detail : null;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? (detail.find((entry) => entry.msg)?.msg ?? response.statusText)
          : response.statusText;

    return new ApiError({
      status: response.status,
      code: fallbackCode(response.status),
      message: message || `Request failed with status ${response.status}`,
      requestId: headerRequestId,
      retryAfterSeconds,
    });
  }

  static network(cause: unknown): ApiError {
    return new ApiError({
      status: 0,
      code: NETWORK_ERROR_CODE,
      message: "Cannot reach the Tessa API",
      cause,
    });
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function describeApiError(error: unknown): string {
  if (!isApiError(error)) {
    return error instanceof Error && error.message ? error.message : "Something went wrong";
  }
  if (error.isNetworkError) {
    return "Cannot reach the Tessa API. Check that it is running.";
  }
  if (error.dependency) {
    return DEPENDENCY_UNAVAILABLE_MESSAGES[error.dependency];
  }
  if (error.status === 429) {
    return error.retryAfterSeconds === null
      ? "Too many requests. Try again shortly."
      : `Too many requests. Try again in ${error.retryAfterSeconds} s.`;
  }
  return error.message || "Something went wrong";
}
