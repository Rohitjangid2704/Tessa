import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { components } from "@/lib/api/schema";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage1Client,
  errorOf,
  STAGE_ONE_IDS,
  type Stage1Client,
} from "@/tests/utils/stage1";

type Schemas = components["schemas"];

let running: RunningMockServer;
let client: Stage1Client;

beforeAll(async () => {
  running = await startMockApi();
  client = createStage1Client(running.baseUrl);
});

afterAll(async () => {
  await running.close();
});

beforeEach(() => {
  mockState.reset();
});

const GRACIE = STAGE_ONE_IDS.gracie;
const BILLING = STAGE_ONE_IDS.billing;
const MISSING_ID = "0198f6f2-4c2a-7d10-9c1e-000000000000";
const environmentPath = (targetId: string) => `/api/v1/targets/${targetId}/environment`;
const healthPath = (targetId: string) => `/api/v1/targets/${targetId}/health`;
const checksPath = (targetId: string) => `/api/v1/targets/${targetId}/health-checks`;

async function readEnvironment(targetId: string = GRACIE): Promise<Schemas["EnvironmentList"]> {
  return (await (
    await client.get(environmentPath(targetId), "viewer")
  ).json()) as Schemas["EnvironmentList"];
}

function variable(list: Schemas["EnvironmentList"], name: string): Schemas["EnvironmentVariable"] {
  const found = list.items.find((item) => item.name === name);
  if (found === undefined) {
    throw new Error(`variable ${name} missing`);
  }
  return found;
}

describe("GET /targets/{id}/environment", () => {
  it("mixes secret, non-secret, stale and required variables and never returns a secret", async () => {
    const list = await readEnvironment();
    expect(list.missing_required).toBe(1);
    expect(list.items.map((item) => item.stale)).toEqual([
      ...new Array<boolean>(10).fill(false),
      true,
      true,
    ]);

    expect(variable(list, "GRACIE_API_URL")).toMatchObject({
      secret: false,
      required: true,
      has_value: true,
      value: "https://gracie-api.qa.example.test",
      kind: "url",
      interface_ids: ["rest_api", "chat_sse"],
    });
    expect(variable(list, "GRACIE_ADMIN_TOKEN")).toMatchObject({
      secret: true,
      has_value: true,
      value: null,
    });
    expect(variable(list, "GRACIE_READONLY_DSN")).toMatchObject({
      secret: true,
      required: true,
      has_value: false,
      last_set_at: null,
    });
    expect(variable(list, "GRACIE_LEGACY_API_KEY")).toMatchObject({ stale: true, has_value: true });
    expect(variable(list, "GRACIE_OPS_HOOK_URL")).toMatchObject({
      required: false,
      has_value: false,
    });
    expect(JSON.stringify(list)).not.toContain("dev-only-seeded");
  });

  it("is empty for a target that never had a bundle and answers 404 for an unknown target", async () => {
    expect(await readEnvironment(BILLING)).toEqual({ items: [], missing_required: 0 });
    expect((await client.get(environmentPath(MISSING_ID))).status).toBe(404);
  });

  it("carries per-variable health from the last check", async () => {
    const list = await readEnvironment();
    expect(variable(list, "GRACIE_API_URL").health).toMatchObject({
      status: "ok",
      message: "HTTP 200",
    });
    expect(variable(list, "GRACIE_EVENTS_URL").health).toMatchObject({
      status: "failed",
      message: "Connection refused or host unreachable",
      latency_ms: null,
    });
    expect(variable(list, "GRACIE_READONLY_DSN").health).toMatchObject({
      status: "skipped",
      message: "No value set for GRACIE_READONLY_DSN",
    });
    expect(variable(list, "GRACIE_CHAT_TIMEOUT_SECONDS").health.status).toBe("unchecked");
  });
});

describe("PATCH /targets/{id}/environment", () => {
  const patch = (
    body: unknown,
    role: "admin" | "member" | "viewer" = "member",
    id: string = GRACIE,
  ) => client.send("PATCH", environmentPath(id), body, { role });

  it("stores values write-only: a secret is never echoed and a plain value is", async () => {
    const response = await patch({
      set: {
        GRACIE_READONLY_DSN:
          "postgresql://qa:dev-only-typed-password@db.qa.example.test:5432/gracie",
        GRACIE_CHAT_TIMEOUT_SECONDS: "45",
        GRACIE_STRICT_CONFIRMATION: " TRUE ",
      },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("dev-only-typed-password");
    const list = JSON.parse(text) as Schemas["EnvironmentList"];
    expect(list.missing_required).toBe(0);
    expect(variable(list, "GRACIE_READONLY_DSN")).toMatchObject({
      has_value: true,
      value: null,
      health: { status: "unchecked" },
    });
    expect(variable(list, "GRACIE_CHAT_TIMEOUT_SECONDS")).toMatchObject({
      value: "45",
      has_value: true,
    });
    expect(variable(list, "GRACIE_STRICT_CONFIRMATION").value).toBe("true");
    expect(variable(list, "GRACIE_READONLY_DSN").last_set_by).not.toBeNull();
    expect(JSON.stringify(await readEnvironment())).not.toContain("dev-only-typed-password");
  });

  it("clears a value, resets its health and counts a required variable as missing again", async () => {
    const list = (await (
      await patch({ clear: ["GRACIE_ADMIN_TOKEN"] })
    ).json()) as Schemas["EnvironmentList"];
    expect(variable(list, "GRACIE_ADMIN_TOKEN")).toMatchObject({
      has_value: false,
      health: { status: "unchecked", checked_at: null },
    });
    expect(list.missing_required).toBe(2);
  });

  it("names every offending entry", async () => {
    const response = await patch({
      set: {
        NOT_DECLARED: "x",
        GRACIE_API_URL: "not-a-url",
        GRACIE_CHAT_TIMEOUT_SECONDS: "fast",
        GRACIE_STRICT_CONFIRMATION: "maybe",
        GRACIE_GUEST_EMAIL: "a@b.test",
      },
      clear: ["ALSO_UNKNOWN", "GRACIE_GUEST_EMAIL"],
    });
    expect(response.status).toBe(422);
    const details = (await errorOf(response)).details;
    expect(details).toContainEqual(
      expect.objectContaining({ loc: ["body", "set", "NOT_DECLARED"], code: "unknown_variable" }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({ loc: ["body", "set", "GRACIE_API_URL"], code: "invalid_value" }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({
        loc: ["body", "set", "GRACIE_CHAT_TIMEOUT_SECONDS"],
        code: "invalid_value",
      }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({
        loc: ["body", "set", "GRACIE_STRICT_CONFIRMATION"],
        code: "invalid_value",
      }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({ loc: ["body", "clear", 0], code: "unknown_variable" }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({
        loc: ["body", "set", "GRACIE_GUEST_EMAIL"],
        code: "conflicting_operation",
      }),
    );
    expect(
      (await readEnvironment()).items.find((item) => item.name === "GRACIE_API_URL")?.value,
    ).toBe("https://gracie-api.qa.example.test");
  });

  it("refuses a plain URL with a password and empty or oversized values", async () => {
    const userinfo = await patch({ set: { GRACIE_API_URL: "https://user:pw@host.test" } });
    expect((await errorOf(userinfo)).details[0]).toMatchObject({
      code: "url_with_userinfo_not_allowed",
    });
    const empty = await patch({ set: { GRACIE_API_URL: "" } });
    expect((await errorOf(empty)).details[0]).toMatchObject({
      loc: ["body", "set", "GRACIE_API_URL"],
      code: "string_too_short",
    });
    const huge = await patch({ set: { GRACIE_GUEST_EMAIL: "x".repeat(65_537) } });
    expect((await errorOf(huge)).details[0]?.code).toBe("string_too_long");
    const typed = await patch({ set: { GRACIE_API_URL: 5 } });
    expect((await errorOf(typed)).details[0]?.code).toBe("string_type");
  });

  it("follows roles and refuses archived targets with 409", async () => {
    expect((await patch({ set: {} }, "viewer")).status).toBe(403);
    expect((await patch({}, "member")).status).toBe(200);
    expect((await patch({}, "member", MISSING_ID)).status).toBe(404);
    expect((await patch({}, "member", STAGE_ONE_IDS.legacyPortal)).status).toBe(409);
  });
});

describe("GET and POST health", () => {
  it("reads the stored report with ok, failed and skipped interfaces", async () => {
    const report = (await (
      await client.get(healthPath(GRACIE), "viewer")
    ).json()) as Schemas["HealthReport"];
    expect(report.checked_at).toBe("2026-09-29T08:45:00.000Z");
    const byId = Object.fromEntries(report.interfaces.map((entry) => [entry.interface_id, entry]));
    expect(Object.keys(byId)).toEqual([
      "chat_sse",
      "rest_api",
      "browser",
      "events_sse",
      "ops_webhook",
      "truth:gracie_db",
    ]);
    expect(byId.rest_api).toMatchObject({ status: "ok", message: "HTTP 200", kind: "http" });
    expect(byId.events_sse).toMatchObject({
      status: "failed",
      latency_ms: null,
      message: "Connection refused or host unreachable",
    });
    expect(byId.ops_webhook).toMatchObject({
      status: "skipped",
      message: "Interface kind webhook is not checked yet",
    });
    expect(byId["truth:gracie_db"]).toMatchObject({
      kind: "truth_source",
      status: "skipped",
      variables: ["GRACIE_READONLY_DSN"],
    });
  });

  it("has a null checked_at and no interfaces before any check, and 404 for unknown targets", async () => {
    expect(await (await client.get(healthPath(BILLING))).json()).toEqual({
      target_id: BILLING,
      checked_at: null,
      interfaces: [],
    });
    expect((await client.get(healthPath(MISSING_ID))).status).toBe(404);
  });

  it("runs the checks now, turns green once the missing variable is set and updates the summary", async () => {
    await client.send(
      "PATCH",
      environmentPath(GRACIE),
      {
        set: {
          GRACIE_EVENTS_URL: "https://gracie-events.qa.example.test",
          GRACIE_READONLY_DSN: "postgresql://qa:secret@db.qa.example.test:5432/gracie",
          GRACIE_OPS_HOOK_URL: "https://hooks.qa.example.test/ops",
        },
      },
      { role: "member" },
    );
    const response = await client.send("POST", checksPath(GRACIE), {}, { role: "member" });
    expect(response.status).toBe(200);
    const report = (await response.json()) as Schemas["HealthReport"];
    const statuses = Object.fromEntries(
      report.interfaces.map((entry) => [entry.interface_id, entry.status]),
    );
    expect(statuses).toEqual({
      chat_sse: "ok",
      rest_api: "ok",
      browser: "ok",
      events_sse: "ok",
      ops_webhook: "skipped",
      "truth:gracie_db": "ok",
    });
    expect(new Date(report.checked_at ?? "").getTime()).toBeGreaterThan(Date.parse("2026-09-30"));

    const summary = (await (
      await client.get("/api/v1/targets?q=gracie")
    ).json()) as Schemas["TargetPage"];
    expect(summary.items[0]?.health).toBe("ok");
    const list = await readEnvironment();
    expect(variable(list, "GRACIE_EVENTS_URL").health.status).toBe("ok");
    expect(variable(list, "GRACIE_READONLY_DSN").health).toMatchObject({
      status: "ok",
      message: "SELECT 1 succeeded",
    });
  });

  it("limits a check to the named interfaces and keeps the others from the stored report", async () => {
    const response = await client.send(
      "POST",
      checksPath(GRACIE),
      { interface_ids: ["events_sse"] },
      { role: "member" },
    );
    const report = (await response.json()) as Schemas["HealthReport"];
    expect(report.interfaces).toHaveLength(6);
    expect(report.interfaces.find((entry) => entry.interface_id === "events_sse")?.status).toBe(
      "failed",
    );
    const unknown = await client.send(
      "POST",
      checksPath(GRACIE),
      { interface_ids: ["rest_api", "nope"] },
      { role: "member" },
    );
    expect(unknown.status).toBe(422);
    expect((await errorOf(unknown)).details[0]).toMatchObject({
      loc: ["body", "interface_ids", 1],
      code: "unknown_interface",
    });
  });

  it("accepts a missing body, needs a valid bundle and the member role", async () => {
    const noBody = await fetch(`${running.baseUrl}${checksPath(GRACIE)}`, {
      method: "POST",
      headers: await client.headers("member"),
    });
    expect(noBody.status).toBe(200);
    const notReady = await client.send("POST", checksPath(BILLING), {}, { role: "member" });
    expect(notReady.status).toBe(409);
    expect((await errorOf(notReady)).code).toBe("target_not_ready");
    const broken = await client.send(
      "POST",
      checksPath(STAGE_ONE_IDS.brokenImport),
      {},
      { role: "member" },
    );
    expect(broken.status).toBe(409);
    expect((await client.send("POST", checksPath(GRACIE), {}, { role: "viewer" })).status).toBe(
      403,
    );
    expect(
      (await client.send("POST", checksPath(STAGE_ONE_IDS.legacyPortal), {}, { role: "member" }))
        .status,
    ).toBe(409);
    expect((await client.send("POST", checksPath(MISSING_ID), {}, { role: "member" })).status).toBe(
      404,
    );
  });

  it("delays the check by the health_slow fault", async () => {
    mockState.faults.apply({ health_slow: 250 });
    const started = Date.now();
    const response = await client.send("POST", checksPath(GRACIE), {}, { role: "member" });
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    mockState.faults.apply({ health_slow: null });
    const quick = Date.now();
    await client.send("POST", checksPath(GRACIE), {}, { role: "member" });
    expect(Date.now() - quick).toBeLessThan(200);
  });
});

describe("Stage 1 state and faults over HTTP", () => {
  it("returns to the seeded fixtures after /__mock/reset", async () => {
    await client.send("DELETE", `/api/v1/targets/${BILLING}`);
    await client.send(
      "PATCH",
      environmentPath(GRACIE),
      { clear: ["GRACIE_ADMIN_TOKEN"] },
      { role: "member" },
    );
    await fetch(`${running.baseUrl}/__mock/reset`, { method: "POST" });
    const names = (
      (await (await client.get("/api/v1/targets")).json()) as Schemas["TargetPage"]
    ).items.map((item) => item.name);
    expect(names).toContain("Billing API");
    expect(variable(await readEnvironment(), "GRACIE_ADMIN_TOKEN").has_value).toBe(true);
  });

  it("toggles health_slow and upload_413 through the control endpoint", async () => {
    const response = await fetch(`${running.baseUrl}/__mock/faults`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ health_slow: 1200, upload_413: true }),
    });
    expect((await response.json()).faults).toMatchObject({ health_slow: 1200, upload_413: true });
    expect((await client.upload({ name: "valid.zip", targetId: BILLING })).status).toBe(413);
    const cleared = await fetch(`${running.baseUrl}/__mock/faults`, { method: "DELETE" });
    expect((await cleared.json()).faults).toMatchObject({ health_slow: 0, upload_413: false });
  });

  it("serves an empty world after seeding the empty preset and restores the fixtures on reset", async () => {
    const seeded = await fetch(`${running.baseUrl}/__mock/stage1/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed: "empty" }),
    });
    expect(await seeded.json()).toEqual({ seed: "empty", targets: 0, bundles: 0 });
    const page = (await (
      await client.get("/api/v1/targets?include_total=true")
    ).json()) as Schemas["TargetPage"];
    expect(page).toEqual({ items: [], next_cursor: null, total: 0 });

    await fetch(`${running.baseUrl}/__mock/reset`, { method: "POST" });
    expect(mockState.stageOne.targets).toHaveLength(5);
  });

  it("lowers the upload limits over HTTP and rejects unknown keys and bad presets", async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${running.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const lowered = await post("/__mock/stage1/limits", { bundle_max_zip_bytes: 10 });
    expect(await lowered.json()).toMatchObject({ bundle_max_zip_bytes: 10 });
    expect((await client.upload({ name: "valid.zip", targetId: BILLING })).status).toBe(413);

    const unknown = await post("/__mock/stage1/limits", { nope: 1 });
    expect(unknown.status).toBe(422);
    expect((await unknown.json()).error.details[0]).toMatchObject({
      loc: ["body", "nope"],
      code: "extra_forbidden",
    });
    expect((await post("/__mock/stage1/seed", { seed: "huge" })).status).toBe(422);
  });
});
