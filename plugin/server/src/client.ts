import createClient, { type Client, type Middleware } from "openapi-fetch";
import { ApiError, apiErrorFromResponse, localError } from "./errors";
import type { MergedPaths } from "./types";

export type Clock = {
  now: () => number;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

function sleepUnlessAborted(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: sleepUnlessAborted,
};

export type TessaApiOptions = {
  baseUrl: string;
  token: string;
  configurationProblem: string | null;
  agentSessionId: () => string | undefined;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  generateId?: () => string;
};

export type TessaApi = {
  client: Client<MergedPaths>;
  baseUrl: string;
};

const IDEMPOTENT_POSTS = new Set([
  "/api/v1/bundles",
  "/api/v1/runs",
  "/api/v1/findings/{finding_id}/explanations",
  "/api/v1/targets/{target_id}/prompt-issues",
  "/api/v1/agent-sessions",
  "/api/v1/targets/{target_id}/proposal/plan",
]);

const UNCONFIGURED_BASE_URL = "http://not-configured.invalid";
const MAX_RETRY_AFTER_MILLISECONDS = 60_000;
const SERVER_ERROR_RETRIES = 2;
const SERVER_ERROR_BACKOFF_MILLISECONDS = 400;

function retryAfterMilliseconds(response: Response): number {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return 1000;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MILLISECONDS);
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) {
    return 1000;
  }
  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MILLISECONDS);
}

function createResilientFetch(options: TessaApiOptions, clock: Clock) {
  const baseFetch = options.fetchImpl ?? globalThis.fetch;

  return async function resilientFetch(request: Request): Promise<Response> {
    if (options.configurationProblem !== null) {
      throw localError("not_configured", options.configurationProblem);
    }
    const isRead = request.method === "GET" || request.method === "HEAD";
    let rateLimitWaited = false;
    let serverErrorRetries = 0;

    for (;;) {
      const attempt = request.clone();
      let response: Response;
      try {
        response = await baseFetch(attempt);
      } catch (cause) {
        if (isRead && serverErrorRetries < SERVER_ERROR_RETRIES) {
          serverErrorRetries += 1;
          await clock.sleep(SERVER_ERROR_BACKOFF_MILLISECONDS * serverErrorRetries);
          continue;
        }
        const message = cause instanceof Error ? cause.message : "request failed";
        throw localError("network_error", `Cannot reach the Tessa API: ${message}`);
      }
      if (response.status === 429 && !rateLimitWaited) {
        rateLimitWaited = true;
        await clock.sleep(retryAfterMilliseconds(response));
        continue;
      }
      if (response.status >= 500 && isRead && serverErrorRetries < SERVER_ERROR_RETRIES) {
        serverErrorRetries += 1;
        await clock.sleep(SERVER_ERROR_BACKOFF_MILLISECONDS * serverErrorRetries);
        continue;
      }
      return response;
    }
  };
}

export function createTessaApi(options: TessaApiOptions): TessaApi {
  const clock = options.clock ?? systemClock;
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  const client = createClient<MergedPaths>({
    baseUrl: options.baseUrl || UNCONFIGURED_BASE_URL,
    fetch: createResilientFetch(options, clock),
  });

  const headers: Middleware = {
    onRequest({ request, schemaPath }) {
      request.headers.set("Authorization", `Bearer ${options.token}`);
      request.headers.set("X-Request-ID", generateId());
      const sessionId = options.agentSessionId();
      if (sessionId !== undefined) {
        request.headers.set("X-Agent-Session", sessionId);
      }
      if (
        request.method === "POST" &&
        IDEMPOTENT_POSTS.has(schemaPath) &&
        !request.headers.has("Idempotency-Key")
      ) {
        request.headers.set("Idempotency-Key", generateId());
      }
      return request;
    },
  };
  client.use(headers);
  return { client, baseUrl: options.baseUrl };
}

type FetchOutcome<Data> = {
  data?: Data;
  error?: unknown;
  response: Response;
};

export async function unwrap<Data>(pending: Promise<FetchOutcome<Data>>): Promise<Data> {
  const outcome = await pending;
  if (outcome.error !== undefined || !outcome.response.ok) {
    throw apiErrorFromResponse(
      outcome.response.status,
      outcome.error,
      outcome.response.headers.get("x-request-id"),
    );
  }
  return outcome.data as Data;
}

export async function unwrapOptional<Data>(
  pending: Promise<FetchOutcome<Data>>,
): Promise<Data | undefined> {
  try {
    return await unwrap(pending);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}
