import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import {
  INLINE_ERROR_META,
  MAX_QUERY_RETRIES,
  QUERY_STALE_TIME_MS,
  getQueryClient,
  makeQueryClient,
  notifyApiError,
  shouldRetryQuery,
} from "./query-client";

const toastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { error: toastError } }));

function apiError(init: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) {
  return new ApiError({ status: 500, code: "internal_error", message: "Boom", ...init });
}

beforeEach(() => {
  toastError.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldRetryQuery", () => {
  it("never retries a 4xx", () => {
    expect(shouldRetryQuery(0, apiError({ status: 404, code: "not_found" }))).toBe(false);
    expect(shouldRetryQuery(0, apiError({ status: 429, code: "rate_limited" }))).toBe(false);
  });

  it("retries 5xx and network failures a limited number of times", () => {
    expect(shouldRetryQuery(0, apiError())).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES - 1, apiError())).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, apiError())).toBe(false);
    expect(shouldRetryQuery(0, ApiError.network(null))).toBe(true);
    expect(shouldRetryQuery(0, new Error("plain"))).toBe(true);
  });
});

describe("notifyApiError", () => {
  it("toasts a 5xx with its request id", () => {
    notifyApiError(apiError({ requestId: "req-42" }));

    expect(toastError).toHaveBeenCalledTimes(1);
    const [title, options] = toastError.mock.calls[0] ?? [];
    expect(title).toBe("Server error");
    expect(options.description).toContain("req-42");
  });

  it("toasts a 429 with the retry delay", () => {
    notifyApiError(apiError({ status: 429, code: "rate_limited", retryAfterSeconds: 9 }));

    const [title, options] = toastError.mock.calls[0] ?? [];
    expect(title).toBe("Rate limited");
    expect(options.description).toContain("9 s");
  });

  it("toasts network failures", () => {
    notifyApiError(ApiError.network(null));

    expect(toastError.mock.calls[0]?.[0]).toBe("Cannot reach the API");
  });

  it("stays silent for 4xx and for errors that are not ApiErrors", () => {
    notifyApiError(apiError({ status: 404, code: "not_found" }));
    notifyApiError(apiError({ status: 422, code: "validation_failed" }));
    notifyApiError(new Error("plain"));

    expect(toastError).not.toHaveBeenCalled();
  });

  it("stays silent when the request opted out because the page shows the error inline", () => {
    notifyApiError(apiError(), INLINE_ERROR_META);
    notifyApiError(ApiError.network(null), INLINE_ERROR_META);
    notifyApiError(apiError({ status: 429, code: "rate_limited" }), INLINE_ERROR_META);

    expect(toastError).not.toHaveBeenCalled();
  });

  it("still toasts when the meta does not opt out", () => {
    notifyApiError(apiError(), { errorToast: true });
    notifyApiError(apiError(), {});

    expect(toastError).toHaveBeenCalledTimes(2);
  });

  it("uses a stable toast id so repeated failures replace one another", () => {
    notifyApiError(apiError());
    notifyApiError(apiError());

    expect(toastError.mock.calls[0]?.[1].id).toBe(toastError.mock.calls[1]?.[1].id);
  });
});

describe("makeQueryClient", () => {
  it("sets a 30 second stale time and no mutation retries", () => {
    const client = makeQueryClient();
    const defaults = client.getDefaultOptions();

    expect(QUERY_STALE_TIME_MS).toBe(30_000);
    expect(defaults.queries?.staleTime).toBe(30_000);
    expect(defaults.mutations?.retry).toBe(false);
  });

  it("toasts a failing query through the query cache", async () => {
    const client = makeQueryClient();

    await client
      .fetchQuery({
        queryKey: ["failing"],
        queryFn: () => Promise.reject(apiError({ requestId: "req-7" })),
        retry: false,
      })
      .catch(() => undefined);

    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("toasts a failing mutation through the mutation cache", async () => {
    const client = makeQueryClient();

    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(apiError()) })
      .execute(undefined)
      .catch(() => undefined);

    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("does not toast a failing query that opted out through its meta", async () => {
    const client = makeQueryClient();

    await client
      .fetchQuery({
        queryKey: ["inline"],
        queryFn: () => Promise.reject(apiError()),
        meta: INLINE_ERROR_META,
        retry: false,
      })
      .catch(() => undefined);

    expect(toastError).not.toHaveBeenCalled();
  });

  it("does not toast a failing mutation that opted out through its meta", async () => {
    const client = makeQueryClient();

    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(apiError()), meta: INLINE_ERROR_META })
      .execute(undefined)
      .catch(() => undefined);

    expect(toastError).not.toHaveBeenCalled();
  });

  it("does not retry a 4xx query", async () => {
    const client = makeQueryClient();
    const queryFn = vi.fn(() => Promise.reject(apiError({ status: 404, code: "not_found" })));

    await client
      .fetchQuery({ queryKey: ["missing"], queryFn, retryDelay: 0 })
      .catch(() => undefined);

    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

describe("getQueryClient", () => {
  it("returns one shared client in the browser", () => {
    expect(getQueryClient()).toBe(getQueryClient());
  });
});
