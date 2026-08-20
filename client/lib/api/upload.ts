import { SessionExpiredError, getToken, refreshToken } from "@/lib/auth/token-client";
import { clientEnv } from "@/lib/env.client";
import { RETRYABLE_UNAUTHENTICATED_CODES, redirectToLogin } from "./authed-fetch";
import { ApiError, TOKEN_UNAVAILABLE_CODE } from "./errors";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const REQUEST_ID_HEADER = "X-Request-ID";
export const IDEMPOTENCY_REPLAYED_HEADER = "Idempotency-Replayed";
export const UNEXPECTED_BODY_CODE = "unexpected_response_body";

export type UploadProgress = {
  loaded: number;
  total: number | null;
  fraction: number | null;
};

export type UploadRequest<Body> = {
  path: string;
  form: FormData;
  idempotencyKey: string;
  parse: (raw: unknown) => Body;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
};

export type UploadResult<Body> = {
  status: number;
  body: Body;
  requestId: string | null;
  replayed: boolean;
};

export type UploadDependencies = {
  getToken: () => Promise<string>;
  refreshToken: (rejectedToken: string) => Promise<string>;
  redirectToLogin: () => void;
  baseUrl: string;
  createXhr?: () => XMLHttpRequest;
  createRequestId?: () => string;
};

type RawResponse = {
  status: number;
  statusText: string;
  headers: Headers;
  text: string;
};

type SendOptions = {
  url: string;
  form: FormData;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
  onProgress: ((progress: UploadProgress) => void) | undefined;
};

export function createUploadAbortError(): DOMException {
  return new DOMException("The upload was aborted", "AbortError");
}

export function isUploadAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function toProgress(event: ProgressEvent): UploadProgress {
  const total = event.lengthComputable && event.total > 0 ? event.total : null;
  return {
    loaded: event.loaded,
    total,
    fraction: total === null ? null : Math.min(1, event.loaded / total),
  };
}

function parseResponseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      try {
        headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
      } catch {
        continue;
      }
    }
  }
  return headers;
}

function parseJson(text: string): unknown {
  if (text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorFrom(raw: RawResponse): ApiError {
  const statusOnly = new Response(null, {
    status: raw.status >= 200 && raw.status <= 599 ? raw.status : 500,
    statusText: raw.statusText,
    headers: raw.headers,
  });
  return ApiError.fromResponse(statusOnly, parseJson(raw.text));
}

function sessionExpiredError(): ApiError {
  return new ApiError({
    status: 401,
    code: "unauthenticated",
    message: "Your session has expired",
  });
}

function tokenUnavailable(cause: unknown): ApiError {
  return new ApiError({
    status: 0,
    code: TOKEN_UNAVAILABLE_CODE,
    message: "Could not obtain an API token",
    cause,
  });
}

export function createUploader(dependencies: UploadDependencies) {
  const createXhr = dependencies.createXhr ?? (() => new XMLHttpRequest());
  const createRequestId = dependencies.createRequestId ?? (() => crypto.randomUUID());
  const baseUrl = dependencies.baseUrl.replace(/\/+$/, "");

  function sendOnce(options: SendOptions): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      const { signal } = options;
      if (signal?.aborted === true) {
        reject(createUploadAbortError());
        return;
      }
      const xhr = createXhr();
      const abort = () => xhr.abort();
      const cleanup = () => signal?.removeEventListener("abort", abort);
      xhr.open("POST", options.url);
      for (const [name, value] of Object.entries(options.headers)) {
        xhr.setRequestHeader(name, value);
      }
      xhr.responseType = "text";
      xhr.upload.onprogress = (event) => options.onProgress?.(toProgress(event));
      xhr.onload = () => {
        cleanup();
        resolve({
          status: xhr.status,
          statusText: xhr.statusText,
          headers: parseResponseHeaders(xhr.getAllResponseHeaders()),
          text: xhr.responseText,
        });
      };
      xhr.onerror = () => {
        cleanup();
        reject(ApiError.network(new Error("The upload request failed")));
      };
      xhr.ontimeout = () => {
        cleanup();
        reject(ApiError.network(new Error("The upload request timed out")));
      };
      xhr.onabort = () => {
        cleanup();
        reject(createUploadAbortError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      xhr.send(options.form);
    });
  }

  function sendWithToken<Body>(request: UploadRequest<Body>, token: string): Promise<RawResponse> {
    request.onProgress?.({ loaded: 0, total: null, fraction: null });
    return sendOnce({
      url: `${baseUrl}${request.path}`,
      form: request.form,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        [IDEMPOTENCY_KEY_HEADER]: request.idempotencyKey,
        [REQUEST_ID_HEADER]: createRequestId(),
      },
      signal: request.signal,
      onProgress: request.onProgress,
    });
  }

  function isRetryableUnauthenticated(raw: RawResponse): boolean {
    if (raw.status !== 401) {
      return false;
    }
    return RETRYABLE_UNAUTHENTICATED_CODES.has(errorFrom(raw).code);
  }

  return async function upload<Body>(request: UploadRequest<Body>): Promise<UploadResult<Body>> {
    let token: string;
    try {
      token = await dependencies.getToken();
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        dependencies.redirectToLogin();
        throw sessionExpiredError();
      }
      throw tokenUnavailable(error);
    }

    let raw = await sendWithToken(request, token);
    if (isRetryableUnauthenticated(raw)) {
      let freshToken: string;
      try {
        freshToken = await dependencies.refreshToken(token);
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          dependencies.redirectToLogin();
          throw errorFrom(raw);
        }
        throw tokenUnavailable(error);
      }
      raw = await sendWithToken(request, freshToken);
      if (raw.status === 401) {
        dependencies.redirectToLogin();
      }
    }

    if (raw.status < 200 || raw.status >= 300) {
      throw errorFrom(raw);
    }
    const requestId = raw.headers.get("x-request-id");
    try {
      return {
        status: raw.status,
        body: request.parse(parseJson(raw.text)),
        requestId,
        replayed: raw.headers.get(IDEMPOTENCY_REPLAYED_HEADER) === "true",
      };
    } catch (cause) {
      throw new ApiError({
        status: raw.status,
        code: UNEXPECTED_BODY_CODE,
        message: "The server answered with a body this page does not understand",
        requestId,
        cause,
      });
    }
  };
}

export const uploadWithProgress = createUploader({
  getToken,
  refreshToken,
  redirectToLogin,
  baseUrl: clientEnv.NEXT_PUBLIC_API_URL,
});
