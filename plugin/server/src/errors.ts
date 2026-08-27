export type ApiErrorDetail = {
  code: string;
  message: string;
  loc?: Array<string | number>;
};

export type ApiErrorInit = {
  code: string;
  status: number;
  message: string;
  requestId?: string | null;
  details?: ApiErrorDetail[];
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: ApiErrorDetail[];

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? [];
  }

  toJSON() {
    return {
      code: this.code,
      status: this.status,
      message: this.message,
      requestId: this.requestId,
      details: this.details,
    };
  }
}

type ErrorEnvelope = {
  error?: {
    code?: unknown;
    message?: unknown;
    request_id?: unknown;
    details?: unknown;
  };
};

function parseDetails(raw: unknown): ApiErrorDetail[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const detail: ApiErrorDetail = {
      code: typeof record.code === "string" ? record.code : "unknown",
      message: typeof record.message === "string" ? record.message : "",
    };
    if (Array.isArray(record.loc)) {
      detail.loc = record.loc.filter(
        (part): part is string | number => typeof part === "string" || typeof part === "number",
      );
    }
    return [detail];
  });
}

export function apiErrorFromResponse(
  status: number,
  body: unknown,
  headerRequestId: string | null,
): ApiError {
  const envelope = (typeof body === "object" && body !== null ? body : {}) as ErrorEnvelope;
  const inner = envelope.error ?? {};
  const code = typeof inner.code === "string" ? inner.code : `http_${status}`;
  const fallbackMessage = typeof body === "string" && body.length > 0 ? body.slice(0, 500) : `HTTP ${status}`;
  const message = typeof inner.message === "string" ? inner.message : fallbackMessage;
  const requestId = typeof inner.request_id === "string" ? inner.request_id : headerRequestId;
  return new ApiError({ code, status, message, requestId, details: parseDetails(inner.details) });
}

export function localError(code: string, message: string, details: ApiErrorDetail[] = []): ApiError {
  return new ApiError({ code, status: 0, message, details });
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return localError("internal_error", message);
}
