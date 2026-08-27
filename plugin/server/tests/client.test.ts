import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTessaApi, unwrap } from "../src/client";
import { ApiError } from "../src/errors";
import { BASE_URL, IDS, TOKEN, errorBody, user } from "./fixtures";
import { createFakeClock, mswServer, requestsTo, resetSeen } from "./harness";

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
beforeEach(() => resetSeen());

function makeApi(sessionId?: string) {
  const clock = createFakeClock();
  let counter = 0;
  const api = createTessaApi({
    baseUrl: BASE_URL,
    token: TOKEN,
    configurationProblem: null,
    agentSessionId: () => sessionId,
    clock,
    generateId: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    },
  });
  return { api, clock };
}

async function failure(pending: Promise<unknown>): Promise<ApiError> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected a rejection");
}

describe("request headers", () => {
  it("sends the bearer token and a request id on every call", async () => {
    const { api } = makeApi();
    await unwrap(api.client.GET("/api/v1/users/me"));
    const [request] = requestsTo("GET", "/users/me");
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers["x-request-id"]).toMatch(/^00000000-0000-4000-8000-/);
    expect(request?.headers["x-agent-session"]).toBeUndefined();
  });

  it("adds the agent session header once the session is known", async () => {
    const { api } = makeApi(IDS.agentSession);
    await unwrap(api.client.GET("/api/v1/users/me"));
    expect(requestsTo("GET", "/users/me")[0]?.headers["x-agent-session"]).toBe(IDS.agentSession);
  });

  it("uses a different request id for each call", async () => {
    const { api } = makeApi();
    await unwrap(api.client.GET("/api/v1/users/me"));
    await unwrap(api.client.GET("/api/v1/users/me"));
    const ids = requestsTo("GET", "/users/me").map((entry) => entry.headers["x-request-id"]);
    expect(new Set(ids).size).toBe(2);
  });

  it("adds an idempotency key to the posts that need one and not to the others", async () => {
    const { api } = makeApi();
    await unwrap(
      api.client.POST("/api/v1/targets/{target_id}/prompt-issues", {
        params: { path: { target_id: IDS.target } },
        body: { template_name: "discovery" },
      }),
    );
    await unwrap(
      api.client.POST("/api/v1/targets/{target_id}/health-checks", {
        params: { path: { target_id: IDS.target } },
        body: null,
      }),
    );
    expect(requestsTo("POST", `/targets/${IDS.target}/prompt-issues`)[0]?.headers["idempotency-key"]).toMatch(
      /^[\x21-\x7E]{8,128}$/,
    );
    expect(requestsTo("POST", `/targets/${IDS.target}/health-checks`)[0]?.headers["idempotency-key"]).toBeUndefined();
  });
});

describe("error mapping", () => {
  it("maps the error envelope to an ApiError", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/api/v1/users/me`, () =>
        HttpResponse.json(errorBody("token_revoked", "This token was revoked"), { status: 401 }),
      ),
    );
    const { api } = makeApi();
    const error = await failure(unwrap(api.client.GET("/api/v1/users/me")));
    expect(error.toJSON()).toEqual({
      code: "token_revoked",
      status: 401,
      message: "This token was revoked",
      requestId: "req-fixture-1",
      details: [],
    });
  });

  it("keeps validation details", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/api/v1/users/me`, () =>
        HttpResponse.json(
          errorBody("validation_failed", "Bad input", [
            { code: "string_too_long", message: "too long", loc: ["body", "text"] },
          ]),
          { status: 422 },
        ),
      ),
    );
    const { api } = makeApi();
    const error = await failure(unwrap(api.client.GET("/api/v1/users/me")));
    expect(error.status).toBe(422);
    expect(error.details).toEqual([{ code: "string_too_long", message: "too long", loc: ["body", "text"] }]);
  });

  it("falls back to the http status for a non JSON error", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/api/v1/users/me`, () => new HttpResponse("gateway exploded", { status: 502 })),
    );
    const { api } = makeApi();
    const error = await failure(unwrap(api.client.GET("/api/v1/users/me")));
    expect(error.code).toBe("http_502");
    expect(error.message).toBe("gateway exploded");
  });

  it("maps a network failure", async () => {
    mswServer.use(http.get(`${BASE_URL}/api/v1/users/me`, () => HttpResponse.error()));
    const { api } = makeApi();
    const error = await failure(unwrap(api.client.GET("/api/v1/users/me")));
    expect(error.code).toBe("network_error");
    expect(error.status).toBe(0);
  });

  it("reports a configuration problem without calling the network", async () => {
    const api = createTessaApi({
      baseUrl: "",
      token: "",
      configurationProblem: "TESSA_TOKEN is not set",
      agentSessionId: () => undefined,
    });
    const error = await failure(unwrap(api.client.GET("/api/v1/users/me")));
    expect(error.code).toBe("not_configured");
    expect(requestsTo("GET", "/users/me")).toHaveLength(0);
  });
});

describe("retries", () => {
  it("waits for Retry-After once on a 429 and then succeeds", async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE_URL}/api/v1/users/me`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(errorBody("rate_limited", "slow down"), {
            status: 429,
            headers: { "Retry-After": "3" },
          });
        }
        return HttpResponse.json(user);
      }),
    );
    const { api, clock } = makeApi();
    const data = await unwrap(api.client.GET("/api/v1/users/me"));
    expect(data.id).toBe(IDS.user);
    expect(calls).toBe(2);
    expect(clock.sleeps).toEqual([3000]);
  });

  it("returns the second 429 as an error", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/api/v1/users/me`, () =>
        HttpResponse.json(errorBody("rate_limited", "slow down"), { status: 429, headers: { "Retry-After": "1" } }),
      ),
    );
    const { api } = makeApi();
    const error = await failure(unwrap(api.client.GET("/api/v1/users/me")));
    expect(error.code).toBe("rate_limited");
    expect(requestsTo("GET", "/users/me")).toHaveLength(2);
  });

  it("retries a GET twice on 5xx", async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE_URL}/api/v1/users/me`, () => {
        calls += 1;
        return calls < 3 ? new HttpResponse("down", { status: 503 }) : HttpResponse.json(user);
      }),
    );
    const { api } = makeApi();
    const data = await unwrap(api.client.GET("/api/v1/users/me"));
    expect(data.id).toBe(IDS.user);
    expect(calls).toBe(3);
  });

  it("gives up on a GET after two retries", async () => {
    mswServer.use(http.get(`${BASE_URL}/api/v1/users/me`, () => new HttpResponse("down", { status: 500 })));
    const { api } = makeApi();
    const error = await failure(unwrap(api.client.GET("/api/v1/users/me")));
    expect(error.status).toBe(500);
    expect(requestsTo("GET", "/users/me")).toHaveLength(3);
  });

  it("never retries a POST on 5xx", async () => {
    mswServer.use(
      http.post(`${BASE_URL}/api/v1/targets/:targetId/prompt-issues`, () => new HttpResponse("down", { status: 500 })),
    );
    const { api } = makeApi();
    const error = await failure(
      unwrap(
        api.client.POST("/api/v1/targets/{target_id}/prompt-issues", {
          params: { path: { target_id: IDS.target } },
          body: { template_name: "discovery" },
        }),
      ),
    );
    expect(error.status).toBe(500);
    expect(requestsTo("POST", `/targets/${IDS.target}/prompt-issues`)).toHaveLength(1);
  });

  it("reuses the idempotency key when a post is retried after a 429", async () => {
    let calls = 0;
    mswServer.use(
      http.post(`${BASE_URL}/api/v1/targets/:targetId/prompt-issues`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(errorBody("rate_limited", "slow"), { status: 429, headers: { "Retry-After": "1" } })
          : HttpResponse.json({ id: "x" }, { status: 201 });
      }),
    );
    const { api } = makeApi();
    await unwrap(
      api.client.POST("/api/v1/targets/{target_id}/prompt-issues", {
        params: { path: { target_id: IDS.target } },
        body: { template_name: "discovery" },
      }),
    );
    const keys = requestsTo("POST", `/targets/${IDS.target}/prompt-issues`).map(
      (entry) => entry.headers["idempotency-key"],
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});
