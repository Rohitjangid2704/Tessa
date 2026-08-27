import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE_URL, IDS, TARGET_TOKEN, agentSession, errorBody } from "./fixtures";
import { createHarness, mswServer, requestsTo, resetSeen } from "./harness";

const API = `${BASE_URL}/api/v1`;

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());
beforeEach(() => resetSeen());

describe("agent session", () => {
  it("is created once with the claude session id, the folder name and the plugin version", async () => {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.post(`${API}/agent-sessions`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(agentSession, { status: 201 });
      }),
    );
    const harness = createHarness({ cwd: join(tmpdir(), "work", "hotel-app") });
    await harness.session.start();
    await harness.session.start();
    expect(requestsTo("POST", "/agent-sessions")).toHaveLength(1);
    expect(received).toMatchObject({
      claude_session_id: "claude-session-1",
      cwd_label: "hotel-app",
      plugin_version: "0.1.0",
    });
    expect(requestsTo("POST", "/agent-sessions")[0]?.headers["idempotency-key"]).toBeTruthy();
    expect(harness.session.state.id).toBe(IDS.agentSession);
  });

  it("is sent on later requests as X-Agent-Session", async () => {
    const harness = createHarness();
    await harness.session.start();
    await harness.call("whoami");
    expect(requestsTo("GET", "/users/me")[0]?.headers["x-agent-session"]).toBe(IDS.agentSession);
  });

  it("is ended once, whatever the number of close signals", async () => {
    let body: Record<string, unknown> = {};
    mswServer.use(
      http.patch(`${API}/agent-sessions/:sessionId`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(agentSession);
      }),
    );
    const harness = createHarness();
    await harness.session.start();
    await Promise.all([harness.session.end(), harness.session.end()]);
    await harness.session.end();
    const patches = requestsTo("PATCH", `/agent-sessions/${IDS.agentSession}`);
    expect(patches).toHaveLength(1);
    expect(typeof body.ended_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.ended_at as string))).toBe(false);
  });

  it("makes no end call when the session was never created", async () => {
    mswServer.use(
      http.post(`${API}/agent-sessions`, () =>
        HttpResponse.json(errorBody("not_found", "no such route"), { status: 404 }),
      ),
    );
    const harness = createHarness();
    await harness.session.start();
    await harness.session.end();
    expect(requestsTo("PATCH", `/agent-sessions/${IDS.agentSession}`)).toHaveLength(0);
  });

  it("never blocks the tools when creating it fails", async () => {
    mswServer.use(
      http.post(`${API}/agent-sessions`, () =>
        HttpResponse.json(errorBody("not_implemented", "later"), { status: 501 }),
      ),
    );
    const harness = createHarness();
    void harness.session.start();
    const result = await harness.call("whoami");
    expect(result.isError).toBe(false);
    expect(harness.session.state.id).toBeUndefined();
    expect(harness.logs.some((entry) => entry.message === "agent session was not created")).toBe(true);
    expect(requestsTo("GET", "/users/me")[0]?.headers["x-agent-session"]).toBeUndefined();
  });

  it("never blocks the tools when the network is down for the session call", async () => {
    mswServer.use(http.post(`${API}/agent-sessions`, () => HttpResponse.error()));
    const harness = createHarness();
    void harness.session.start();
    const result = await harness.call("list_targets");
    expect(result.isError).toBe(false);
  });

  it("patches the target when one is selected", async () => {
    let body: Record<string, unknown> = {};
    mswServer.use(
      http.patch(`${API}/agent-sessions/:sessionId`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(agentSession);
      }),
    );
    const harness = createHarness();
    await harness.session.start();
    await harness.session.selectTarget({ id: IDS.target, target_token: TARGET_TOKEN });
    expect(body).toEqual({ target_id: IDS.target });
  });
});
