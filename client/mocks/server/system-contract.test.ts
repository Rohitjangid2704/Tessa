import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import { createHelloRun, postJson, requestWsTicket, startMockApi } from "@/tests/utils/mock-api";
import { bearer, mintApiToken } from "@/tests/utils/tokens";

let running: RunningMockServer;
let adminToken: string;

beforeAll(async () => {
  running = await startMockApi();
});

afterAll(async () => {
  await running.close();
});

beforeEach(async () => {
  mockState.reset();
  adminToken = await mintApiToken();
});

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${running.baseUrl}${path}`, { headers });
}

function startHello(
  body: unknown,
  headers: Record<string, string> = {},
  token: string = adminToken,
) {
  return postJson(running.baseUrl, "/api/v1/system/hello-runs", body, {
    ...bearer(token),
    ...headers,
  });
}

describe("liveness", () => {
  it("serves the root banner and /health", async () => {
    expect(await (await get("/")).json()).toEqual({ name: "Tessa API", status: "ready" });
    expect(await (await get("/health")).json()).toEqual({ status: "ok" });
  });

  it("serves /health without authentication and keeps answering while dependencies are down", async () => {
    mockState.faults.apply({ dependencies_down: true });
    expect((await get("/health")).status).toBe(200);
  });
});

describe("GET /health/dependencies", () => {
  it("requires a token", async () => {
    const response = await get("/health/dependencies");
    expect(response.status).toBe(401);
  });

  it("reports db, temporal and laya up and storage unconfigured", async () => {
    const response = await get(
      "/health/dependencies",
      bearer(await mintApiToken({ user: VIEWER_USER })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      db: { status: "up", latency_ms: 3, detail: null },
      temporal: { status: "up", latency_ms: 5, detail: null },
      laya: { status: "up", latency_ms: 12, detail: "HTTP 200" },
      storage: {
        status: "unconfigured",
        latency_ms: null,
        detail: "storage is defined in Phase 1",
      },
    });
  });

  it("reports db, temporal and laya down for dependencies_down true, never failing the call", async () => {
    mockState.faults.apply({ dependencies_down: true });

    const response = await get("/health/dependencies", bearer(adminToken));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.db).toEqual({ status: "down", latency_ms: null, detail: "OperationalError" });
    expect(body.temporal.status).toBe("down");
    expect(body.laya.status).toBe("down");
    expect(body.storage.status).toBe("unconfigured");
  });

  it("reports only the named dependencies down", async () => {
    mockState.faults.apply({ dependencies_down: ["laya"] });

    const body = await (await get("/health/dependencies", bearer(adminToken))).json();

    expect(body.laya.status).toBe("down");
    expect(body.db.status).toBe("up");
    expect(body.temporal.status).toBe("up");
  });
});

describe("schemas", () => {
  it("lists the published schemas with urls on the request origin and matching hashes", async () => {
    const response = await get("/schemas/index.json");
    const index = await response.json();

    expect(response.status).toBe(200);
    expect(index.schemas.map((entry: { name: string }) => entry.name)).toEqual([
      "bundle",
      "stream-event",
    ]);
    for (const entry of index.schemas) {
      expect(entry).toMatchObject({
        version: 1,
        stage: 0,
        url: `${running.baseUrl}/schemas/${entry.name}.v1.json`,
      });
      const document = await get(`/schemas/${entry.name}.v1.json`);
      const text = await document.text();
      expect(createHash("sha256").update(text).digest("hex")).toBe(entry.sha256);
    }
  });

  it("serves bundle.v1.json as a JSON Schema whose $id is its own url", async () => {
    const response = await get("/schemas/bundle.v1.json");
    const schema = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/schema+json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(schema.$id).toBe(`${running.baseUrl}/schemas/bundle.v1.json`);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(expect.arrayContaining(["app", "interfaces", "features"]));
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["app", "interfaces", "features"]),
    );
  });

  it("serves stream-event.v1.json", async () => {
    const schema = await (await get("/schemas/stream-event.v1.json")).json();
    expect(schema.properties.type.enum).toContain("hello.tick");
  });

  it("supports conditional requests with an ETag", async () => {
    const first = await get("/schemas/bundle.v1.json");
    const etag = first.headers.get("etag") ?? "";
    const second = await get("/schemas/bundle.v1.json", { "If-None-Match": etag });

    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it.each(["/schemas/unknown.v1.json", "/schemas/bundle.v2.json", "/schemas/bundle.json"])(
    "answers 404 not_found for %s",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("not_found");
    },
  );
});

describe("POST /api/v1/system/hello-runs", () => {
  const key = "idempotency-key-0001";

  it("answers 202 with a RunHandle and writes run.created before returning", async () => {
    const response = await startHello(
      { ticks: 2, tick_interval_ms: 100 },
      { "Idempotency-Key": key },
    );
    const handle = await response.json();

    expect(response.status).toBe(202);
    expect(handle).toEqual({
      run_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      workflow_id: `hello-${handle.run_id}`,
      kind: "hello",
      status: "queued",
      created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
    });

    const events = await (
      await get(`/api/v1/runs/${handle.run_id}/events`, bearer(adminToken))
    ).json();
    expect(events.items[0]).toMatchObject({
      type: "run.created",
      seq: 1,
      run_id: handle.run_id,
      payload: {
        kind: "hello",
        target_id: null,
        plan_id: null,
        trigger: "manual",
        created_by: expect.any(String),
        status: "queued",
      },
    });
  });

  it("requires a valid Idempotency-Key", async () => {
    const invalidHeaders: Array<Record<string, string>> = [
      {},
      { "Idempotency-Key": "short" },
      { "Idempotency-Key": "has space in it" },
    ];
    for (const headers of invalidHeaders) {
      const response = await startHello({}, headers);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("idempotency_key_required");
    }
  });

  it("replays the original response for the same key and body without starting another run", async () => {
    const first = await startHello({ ticks: 3 }, { "Idempotency-Key": key });
    const second = await startHello({ ticks: 3 }, { "Idempotency-Key": key });

    expect(second.status).toBe(202);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(first.headers.has("idempotency-replayed")).toBe(false);
    expect(await second.json()).toEqual(await first.json());
    expect(mockState.runs.size).toBe(1);
  });

  it("scopes keys to the user", async () => {
    const memberToken = await mintApiToken({ user: MEMBER_USER });
    await startHello({}, { "Idempotency-Key": key });
    const other = await startHello({}, { "Idempotency-Key": key }, memberToken);

    expect(other.status).toBe(202);
    expect(other.headers.has("idempotency-replayed")).toBe(false);
    expect(mockState.runs.size).toBe(2);
  });

  it("answers 409 idempotency_conflict for the same key with a different body", async () => {
    await startHello({ ticks: 3 }, { "Idempotency-Key": key });
    const response = await startHello({ ticks: 4 }, { "Idempotency-Key": key });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("idempotency_conflict");
  });

  it("applies the defaults for an empty object", async () => {
    const response = await startHello({}, { "Idempotency-Key": key });
    expect(response.status).toBe(202);
  });

  it.each([
    [{ ticks: 0 }, "ticks", "greater_than_equal"],
    [{ ticks: 61 }, "ticks", "less_than_equal"],
    [{ ticks: 2.5 }, "ticks", "int_from_float"],
    [{ ticks: "5" }, "ticks", "int_type"],
    [{ tick_interval_ms: 99 }, "tick_interval_ms", "greater_than_equal"],
    [{ tick_interval_ms: 10_001 }, "tick_interval_ms", "less_than_equal"],
    [{ include_laya: "yes" }, "include_laya", "bool_type"],
  ])("answers 422 for %j", async (body, field, code) => {
    const response = await startHello(body, { "Idempotency-Key": key });
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.error.code).toBe("validation_failed");
    expect(payload.error.details).toEqual([
      { loc: ["body", field], code, message: expect.any(String) },
    ]);
  });

  it("answers 422 for an empty body", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/system/hello-runs`, {
      method: "POST",
      headers: { ...bearer(adminToken), "Idempotency-Key": key },
    });
    expect(response.status).toBe(422);
  });

  it("answers 503 dependency_unavailable naming temporal while hello_503 is on", async () => {
    mockState.faults.apply({ hello_503: true });

    const response = await startHello({}, { "Idempotency-Key": key });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("dependency_unavailable");
    expect(body.error.details).toEqual([
      { loc: ["dependency"], code: "temporal", message: "Temporal is not running" },
    ]);
    expect(mockState.runs.size).toBe(0);
  });

  it("does not store the idempotency key of a 503", async () => {
    mockState.faults.apply({ hello_503: true });
    await startHello({}, { "Idempotency-Key": key });
    mockState.faults.apply({ hello_503: false });

    const retry = await startHello({}, { "Idempotency-Key": key });

    expect(retry.status).toBe(202);
    expect(retry.headers.has("idempotency-replayed")).toBe(false);
  });

  it("replays an earlier success even while hello_503 is on", async () => {
    await startHello({}, { "Idempotency-Key": key });
    mockState.faults.apply({ hello_503: true });

    const replay = await startHello({}, { "Idempotency-Key": key });

    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
  });
});

describe("GET /api/v1/runs/{run_id}/events", () => {
  async function runWithEvents(eventCount: number) {
    const handle = await createHelloRun(running.baseUrl, adminToken, { ticks: 1 });
    const run = mockState.runs.get(handle.run_id);
    if (run === undefined) {
      throw new Error("run missing");
    }
    for (let index = run.events.length; index < eventCount; index += 1) {
      mockState.appendEvent(run, "hello.tick", { n: index, total: eventCount, message: "tick" });
    }
    return handle.run_id;
  }

  it("requires a token", async () => {
    const runId = await runWithEvents(1);
    expect((await get(`/api/v1/runs/${runId}/events`)).status).toBe(401);
  });

  it("pages ascending by seq with head_seq and has_more", async () => {
    const runId = await runWithEvents(10);

    const page = await (
      await get(`/api/v1/runs/${runId}/events?limit=4`, bearer(adminToken))
    ).json();

    expect(page.items.map((event: { seq: number }) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(page.head_seq).toBe(10);
    expect(page.has_more).toBe(true);
    expect(page.items[0]).toEqual({
      type: "run.created",
      run_id: runId,
      seq: 1,
      ts: expect.any(String),
      payload: expect.any(Object),
    });
  });

  it("continues after after_seq and reports the end", async () => {
    const runId = await runWithEvents(6);

    const page = await (
      await get(`/api/v1/runs/${runId}/events?after_seq=4&limit=10`, bearer(adminToken))
    ).json();

    expect(page.items.map((event: { seq: number }) => event.seq)).toEqual([5, 6]);
    expect(page.has_more).toBe(false);
  });

  it("orders descending and honours before_seq", async () => {
    const runId = await runWithEvents(8);

    const page = await (
      await get(`/api/v1/runs/${runId}/events?order=desc&before_seq=6&limit=3`, bearer(adminToken))
    ).json();

    expect(page.items.map((event: { seq: number }) => event.seq)).toEqual([5, 4, 3]);
    expect(page.has_more).toBe(true);
    expect(page.head_seq).toBe(8);
  });

  it("filters by repeated type parameters", async () => {
    const runId = await runWithEvents(5);

    const page = await (
      await get(`/api/v1/runs/${runId}/events?type=run.created&type=hello.tick`, bearer(adminToken))
    ).json();

    expect(page.items).toHaveLength(5);
    const onlyCreated = await (
      await get(`/api/v1/runs/${runId}/events?type=run.created`, bearer(adminToken))
    ).json();
    expect(onlyCreated.items).toHaveLength(1);
  });

  it("answers 404 not_found for a run without events", async () => {
    const response = await get(
      "/api/v1/runs/0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11/events",
      bearer(adminToken),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("answers 422 with locations for bad path and query values", async () => {
    const response = await get(
      "/api/v1/runs/not-a-uuid/events?after_seq=-1&limit=500&order=sideways&before_seq=abc",
      bearer(adminToken),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(
      body.error.details.map((detail: { loc: unknown[]; code: string }) => [
        detail.loc,
        detail.code,
      ]),
    ).toEqual([
      [["path", "run_id"], "uuid_parsing"],
      [["query", "after_seq"], "greater_than_equal"],
      [["query", "before_seq"], "int_parsing"],
      [["query", "order"], "literal_error"],
      [["query", "limit"], "less_than_equal"],
    ]);
  });
});

describe("POST /api/v1/ws-tickets", () => {
  it("returns a run-scoped ticket, a ws url on the request host and a 30 second expiry", async () => {
    const handle = await createHelloRun(running.baseUrl, adminToken);

    const before = Date.now();
    const ticket = await requestWsTicket(running.baseUrl, adminToken, handle.run_id);

    expect(ticket.ws_url).toBe(
      `${running.wsBaseUrl}/ws/v1/runs/${handle.run_id}?ticket=${ticket.ticket}`,
    );
    expect(ticket.ticket.split(".")).toHaveLength(3);
    const expiresIn = Date.parse(ticket.expires_at) - before;
    expect(expiresIn).toBeGreaterThan(28_000);
    expect(expiresIn).toBeLessThanOrEqual(31_000);
  });

  it("requires a token", async () => {
    const handle = await createHelloRun(running.baseUrl, adminToken);
    const response = await postJson(running.baseUrl, "/api/v1/ws-tickets", {
      run_id: handle.run_id,
    });
    expect(response.status).toBe(401);
  });

  it("is open to the viewer role", async () => {
    const handle = await createHelloRun(running.baseUrl, adminToken);
    const viewerToken = await mintApiToken({ user: VIEWER_USER });
    expect(
      (
        await postJson(
          running.baseUrl,
          "/api/v1/ws-tickets",
          { run_id: handle.run_id },
          bearer(viewerToken),
        )
      ).status,
    ).toBe(200);
  });

  it("answers 404 not_found for a run that does not exist", async () => {
    const response = await postJson(
      running.baseUrl,
      "/api/v1/ws-tickets",
      { run_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11" },
      bearer(adminToken),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("answers 422 for a missing or malformed run_id", async () => {
    const missing = await postJson(running.baseUrl, "/api/v1/ws-tickets", {}, bearer(adminToken));
    const malformed = await postJson(
      running.baseUrl,
      "/api/v1/ws-tickets",
      { run_id: "nope" },
      bearer(adminToken),
    );

    expect((await missing.json()).error.details[0]).toMatchObject({
      loc: ["body", "run_id"],
      code: "missing",
    });
    expect((await malformed.json()).error.details[0]).toMatchObject({
      loc: ["body", "run_id"],
      code: "uuid_parsing",
    });
  });
});

describe("faults", () => {
  it("delays every API response by latency_ms but not the control endpoints", async () => {
    mockState.faults.apply({ latency_ms: 150 });

    const delayed = Date.now();
    await get("/health");
    const apiMs = Date.now() - delayed;
    const control = Date.now();
    await get("/__mock/faults");
    const controlMs = Date.now() - control;

    expect(apiMs).toBeGreaterThanOrEqual(140);
    expect(controlMs).toBeLessThan(100);
  });

  it("reads, patches and clears faults over HTTP", async () => {
    const initial = await (await get("/__mock/faults")).json();
    expect(initial).toEqual({
      faults: {
        ws_close_4413: 0,
        ws_gap: 0,
        token_expired_once: 0,
        artifact_expired: 0,
        budget_exhausted: 0,
        feed_drop: 0,
        verdict_flaky: false,
        verify_429: false,
        dependencies_down: [],
        hello_503: false,
        health_slow: 0,
        upload_413: false,
        label_replaced_200: false,
        settings_422: false,
        service_test_fail: [],
        oracle_error: false,
        latency_ms: 0,
      },
    });

    const patched = await postJson(running.baseUrl, "/__mock/faults", {
      ws_close_4413: true,
      ws_gap: 2,
      token_expired_once: true,
      verify_429: true,
      dependencies_down: ["db", "laya"],
      hello_503: true,
      health_slow: true,
      upload_413: true,
      label_replaced_200: true,
      settings_422: true,
      service_test_fail: ["openai", "jev"],
      oracle_error: true,
      latency_ms: 25,
    });
    expect((await patched.json()).faults).toEqual({
      ws_close_4413: 1,
      ws_gap: 2,
      token_expired_once: 1,
      artifact_expired: 0,
      budget_exhausted: 0,
      feed_drop: 0,
      verdict_flaky: false,
      verify_429: true,
      dependencies_down: ["db", "laya"],
      hello_503: true,
      health_slow: 3000,
      upload_413: true,
      label_replaced_200: true,
      settings_422: true,
      service_test_fail: ["openai", "jev"],
      oracle_error: true,
      latency_ms: 25,
    });

    const partial = await postJson(running.baseUrl, "/__mock/faults", {
      verify_429: null,
      ws_gap: false,
    });
    expect((await partial.json()).faults).toMatchObject({
      verify_429: false,
      ws_gap: 0,
      ws_close_4413: 1,
      latency_ms: 25,
    });

    const cleared = await fetch(`${running.baseUrl}/__mock/faults`, { method: "DELETE" });
    expect((await cleared.json()).faults.latency_ms).toBe(0);
    expect(mockState.faults.snapshot().hello_503).toBe(false);
  });

  it("rejects unknown fault names and bad values with 422", async () => {
    const unknown = await postJson(running.baseUrl, "/__mock/faults", { nope: true });
    const badValue = await postJson(running.baseUrl, "/__mock/faults", { latency_ms: -5 });

    expect(unknown.status).toBe(422);
    expect((await unknown.json()).error.details[0]).toMatchObject({
      loc: ["body", "nope"],
      code: "extra_forbidden",
    });
    expect(badValue.status).toBe(422);
  });

  it("resets runs, idempotency keys and faults", async () => {
    await startHello({}, { "Idempotency-Key": "idempotency-key-0001" });
    mockState.faults.apply({ hello_503: true });

    const response = await postJson(running.baseUrl, "/__mock/reset", {});
    const state = await (await get("/__mock/state")).json();

    expect(response.status).toBe(200);
    expect(state.runs).toEqual([]);
    expect(state.faults.hello_503).toBe(false);
    expect(mockState.idempotency.size).toBe(0);
  });

  it("describes runs and connections", async () => {
    const handle = await createHelloRun(running.baseUrl, adminToken);

    const state = await (await get("/__mock/state")).json();

    expect(state.runs).toEqual([{ run_id: handle.run_id, events: 1, finished: false }]);
    expect(state.connections).toEqual({ opened: 0, open: 0, ticketsIssued: 0 });
  });
});
