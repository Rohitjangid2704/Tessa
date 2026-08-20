import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionExpiredError, TokenMintError } from "@/lib/auth/token-client";
import { createAuthedFetch } from "./authed-fetch";
import { ApiError } from "./errors";

function errorBody(code: string) {
  return { error: { code, message: code, request_id: "req-1", details: [] } };
}

function unauthorized(code: string) {
  return Response.json(errorBody(code), { status: 401 });
}

function setup(options: { responses: Array<Response | Error>; token?: string; fresh?: string }) {
  const sent: Request[] = [];
  const queue = [...options.responses];
  const sendMock = vi.fn(async (request: Request) => {
    sent.push(request);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("no response queued");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  const dependencies = {
    getToken: vi.fn(async () => options.token ?? "token-1"),
    refreshToken: vi.fn<(rejectedToken: string) => Promise<string>>(
      async () => options.fresh ?? "token-2",
    ),
    redirectToLogin: vi.fn(),
    fetch: sendMock,
    createRequestId: vi.fn(() => "generated-id"),
  };
  return { authedFetch: createAuthedFetch(dependencies), dependencies, sent };
}

function getRequest(path = "/api/v1/users/me") {
  return new Request(`http://api.test${path}`);
}

function postRequest(body: unknown) {
  return new Request("http://api.test/api/v1/system/hello-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "key-12345678" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authedFetch", () => {
  it("adds the bearer token and a request id", async () => {
    const { authedFetch, sent } = setup({ responses: [Response.json({ ok: true })] });

    const response = await authedFetch(getRequest());

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get("Authorization")).toBe("Bearer token-1");
    expect(sent[0]?.headers.get("X-Request-ID")).toBe("generated-id");
  });

  it("keeps a request id the caller already set", async () => {
    const { authedFetch, sent } = setup({ responses: [Response.json({})] });
    const request = new Request("http://api.test/health", { headers: { "X-Request-ID": "mine" } });

    await authedFetch(request);

    expect(sent[0]?.headers.get("X-Request-ID")).toBe("mine");
  });

  it("does not refresh or redirect on success or on other errors", async () => {
    const { authedFetch, dependencies } = setup({
      responses: [Response.json(errorBody("forbidden"), { status: 403 })],
    });

    const response = await authedFetch(getRequest());

    expect(response.status).toBe(403);
    expect(dependencies.refreshToken).not.toHaveBeenCalled();
    expect(dependencies.redirectToLogin).not.toHaveBeenCalled();
  });

  it.each(["token_expired", "unauthenticated"])(
    "refreshes once and resends once after a 401 %s",
    async (code) => {
      const { authedFetch, dependencies, sent } = setup({
        responses: [unauthorized(code), Response.json({ id: "u1" })],
      });

      const response = await authedFetch(postRequest({ ticks: 3 }));

      expect(response.status).toBe(200);
      expect(dependencies.refreshToken).toHaveBeenCalledTimes(1);
      expect(dependencies.refreshToken).toHaveBeenCalledWith("token-1");
      expect(dependencies.redirectToLogin).not.toHaveBeenCalled();
      expect(sent).toHaveLength(2);
      expect(sent[0]?.headers.get("Authorization")).toBe("Bearer token-1");
      expect(sent[1]?.headers.get("Authorization")).toBe("Bearer token-2");
      expect(sent[1]?.headers.get("Idempotency-Key")).toBe("key-12345678");
      await expect(sent[1]?.json()).resolves.toEqual({ ticks: 3 });
    },
  );

  it("retries a 401 with FastAPI's default body", async () => {
    const { authedFetch, sent } = setup({
      responses: [
        Response.json({ detail: "Not authenticated" }, { status: 401 }),
        Response.json({ ok: true }),
      ],
    });

    const response = await authedFetch(getRequest());

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it("goes to login when the retry is still unauthorized", async () => {
    const { authedFetch, dependencies, sent } = setup({
      responses: [unauthorized("token_expired"), unauthorized("unauthenticated")],
    });

    const response = await authedFetch(getRequest());

    expect(response.status).toBe(401);
    expect(sent).toHaveLength(2);
    expect(dependencies.redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 401 with another error code", async () => {
    const { authedFetch, dependencies, sent } = setup({
      responses: [unauthorized("invalid_credentials")],
    });

    const response = await authedFetch(getRequest());

    expect(response.status).toBe(401);
    expect(sent).toHaveLength(1);
    expect(dependencies.refreshToken).not.toHaveBeenCalled();
  });

  it("goes to login and skips the request when the session is gone before sending", async () => {
    const { authedFetch, dependencies, sent } = setup({ responses: [] });
    dependencies.getToken.mockRejectedValue(new SessionExpiredError());

    const response = await authedFetch(getRequest());

    expect(response.status).toBe(401);
    expect(sent).toHaveLength(0);
    expect(dependencies.redirectToLogin).toHaveBeenCalledTimes(1);
    const error = ApiError.fromResponse(response, await response.json());
    expect(error.code).toBe("unauthenticated");
  });

  it("goes to login when the session ends while refreshing", async () => {
    const { authedFetch, dependencies, sent } = setup({
      responses: [unauthorized("token_expired")],
    });
    dependencies.refreshToken.mockRejectedValue(new SessionExpiredError());

    const response = await authedFetch(getRequest());

    expect(response.status).toBe(401);
    expect(sent).toHaveLength(1);
    expect(dependencies.redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("raises token_unavailable when a token cannot be minted", async () => {
    const { authedFetch, dependencies } = setup({ responses: [] });
    dependencies.getToken.mockRejectedValue(new TokenMintError("boom", 500));

    const error = await authedFetch(getRequest()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "token_unavailable", status: 0 });
    expect(dependencies.redirectToLogin).not.toHaveBeenCalled();
  });

  it("raises a network ApiError when the API cannot be reached", async () => {
    const { authedFetch } = setup({ responses: [new TypeError("Failed to fetch")] });

    const error = await authedFetch(getRequest()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "network_error", status: 0 });
  });
});
