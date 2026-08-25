import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SecretStatus, ServiceTestResult, SettingsRead } from "@/lib/api/types";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import { createStage1Client, errorOf, type Stage1Client } from "@/tests/utils/stage1";

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

const SETTINGS_PATH = "/api/v1/settings";
const secretPath = (name: string) => `${SETTINGS_PATH}/secrets/${name}`;
const testPath = (service: string) => `${SETTINGS_PATH}/test/${service}`;
const TYPED_SECRET = "dev-only-settings-secret-4c91d7";

const MODEL_ROLES = [
  "generate",
  "explore",
  "simulate",
  "attack",
  "judge",
  "judge_tiebreak",
  "skeptic",
];

async function readSettings(role: "admin" | "member" | "viewer" = "viewer"): Promise<SettingsRead> {
  return (await (await client.get(SETTINGS_PATH, role)).json()) as SettingsRead;
}

function patch(body: unknown, role: "admin" | "member" | "viewer" = "admin") {
  return client.send("PATCH", SETTINGS_PATH, body, { role });
}

async function controlFaults(body: unknown): Promise<Response> {
  return fetch(`${running.baseUrl}/__mock/faults`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /settings", () => {
  it("returns every model role from the env defaults with no override", async () => {
    const settings = await readSettings();

    expect(Object.keys(settings.models)).toEqual(MODEL_ROLES);
    for (const role of MODEL_ROLES) {
      expect(settings.models[role]).toMatchObject({ source: "env" });
      expect(settings.models[role]?.model).toEqual(expect.any(String));
      expect(["minimal", "low", "medium", "high"]).toContain(settings.models[role]?.effort);
      expect(settings.models[role]?.max_usd).toBeGreaterThan(0);
      expect(settings.models[role]?.timeout_seconds).toBeGreaterThan(0);
    }
    expect(settings.overrides).toEqual([]);
    expect(settings.thresholds).toEqual({
      probe_confidence: 0.75,
      judge_escalate_below: 0.6,
      label_audit_rate: 0.05,
    });
    expect(settings.endpoints).toEqual({ laya_url: "http://127.0.0.1:7006", jev_url: null });
    expect(settings.budgets).toEqual({
      default_max_usd: 5,
      default_max_minutes: 30,
      max_concurrency: 4,
    });
    expect(settings.notifications).toBeNull();
    expect(settings.policies).toBeNull();
  });

  it("shows the five secrets in mixed states and never a value", async () => {
    const settings = await readSettings();

    expect(Object.keys(settings.secrets)).toEqual([
      "openai_api_key",
      "anthropic_api_key",
      "jev_api_key",
      "slack_webhook_url",
      "smtp_password",
    ]);
    expect(settings.secrets.openai_api_key).toEqual({
      name: "openai_api_key",
      has_value: true,
      last_set_at: null,
      last_set_by: null,
      source: "env",
    });
    expect(settings.secrets.anthropic_api_key).toMatchObject({ has_value: true, source: "db" });
    expect(settings.secrets.anthropic_api_key?.last_set_at).not.toBeNull();
    expect(settings.secrets.anthropic_api_key?.last_set_by).not.toBeNull();
    expect(settings.secrets.jev_api_key).toMatchObject({ has_value: false, source: null });
    expect(settings.secrets.slack_webhook_url).toMatchObject({ has_value: false, source: null });
    expect(settings.secrets.smtp_password).toMatchObject({ has_value: true, source: "db" });
    for (const status of Object.values(settings.secrets)) {
      expect(Object.keys(status).sort()).toEqual([
        "has_value",
        "last_set_at",
        "last_set_by",
        "name",
        "source",
      ]);
    }
  });

  it("is readable by every role and needs a token", async () => {
    for (const role of ["viewer", "member", "admin"] as const) {
      expect((await client.get(SETTINGS_PATH, role)).status).toBe(200);
    }
    const anonymous = await fetch(`${running.baseUrl}${SETTINGS_PATH}`);
    expect(anonymous.status).toBe(401);
  });
});

describe("PATCH /settings", () => {
  it("merges per leaf, reports the override paths and flips the role source to db", async () => {
    const response = await patch({
      models: { judge: { effort: "high", max_usd: 0.1 } },
      thresholds: { probe_confidence: 0.8 },
    });

    expect(response.status).toBe(200);
    const settings = (await response.json()) as SettingsRead;
    expect(settings.models.judge).toMatchObject({
      model: "gpt-5-mini",
      effort: "high",
      max_usd: 0.1,
      timeout_seconds: 60,
      source: "db",
    });
    expect(settings.models.generate?.source).toBe("env");
    expect(settings.thresholds.probe_confidence).toBe(0.8);
    expect(settings.thresholds.judge_escalate_below).toBe(0.6);
    expect(settings.overrides).toEqual([
      "models.judge.effort",
      "models.judge.max_usd",
      "thresholds.probe_confidence",
    ]);
    expect(await readSettings()).toEqual(settings);
  });

  it("removes an override with null and the leaf falls back to the env default", async () => {
    await patch({ models: { judge: { effort: "high", model: "gpt-5.2-custom" } } });

    const settings = (await (
      await patch({ models: { judge: { effort: null } } })
    ).json()) as SettingsRead;

    expect(settings.models.judge).toMatchObject({
      effort: "low",
      model: "gpt-5.2-custom",
      source: "db",
    });
    expect(settings.overrides).toEqual(["models.judge.model"]);

    const cleared = (await (
      await patch({ models: { judge: { model: null } } })
    ).json()) as SettingsRead;
    expect(cleared.models.judge).toMatchObject({ model: "gpt-5-mini", source: "env" });
    expect(cleared.overrides).toEqual([]);
  });

  it("reads a leaf with no env default as null after the override is removed", async () => {
    const set = (await (
      await patch({ endpoints: { jev_url: "https://jev.qa.example.test" } })
    ).json()) as SettingsRead;
    expect(set.endpoints.jev_url).toBe("https://jev.qa.example.test");
    expect(set.overrides).toEqual(["endpoints.jev_url"]);

    const removed = (await (await patch({ endpoints: { jev_url: null } })).json()) as SettingsRead;
    expect(removed.endpoints.jev_url).toBeNull();
    expect(removed.overrides).toEqual([]);
  });

  it("answers 200 and changes nothing for an empty patch or a null on a leaf with no override", async () => {
    const before = await readSettings();

    const empty = await patch({});
    const nothing = await patch({ thresholds: { label_audit_rate: null } });

    expect(empty.status).toBe(200);
    expect(nothing.status).toBe(200);
    expect(await readSettings()).toEqual(before);
  });

  it("rejects an unknown effort with the loc of the leaf and stores nothing", async () => {
    const response = await patch({
      models: { judge: { effort: "ultra", max_usd: 0.1 } },
    });

    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("validation_failed");
    expect(error.details).toEqual([
      {
        loc: ["body", "models", "judge", "effort"],
        code: "enum",
        message: "Input should be 'minimal', 'low', 'medium' or 'high'",
      },
    ]);
    expect((await readSettings()).overrides).toEqual([]);
  });

  it("rejects out of range and badly typed values with one detail per leaf", async () => {
    const response = await patch({
      thresholds: { probe_confidence: 1.5, judge_escalate_below: -0.1, label_audit_rate: "high" },
      budgets: { default_max_usd: 0, default_max_minutes: 2.5, max_concurrency: 0 },
      models: { judge: { timeout_seconds: 0, max_usd: -1 } },
      endpoints: { laya_url: "ftp://laya.example.test", jev_url: "not a url" },
    });

    expect(response.status).toBe(422);
    const details = (await errorOf(response)).details;
    const byLoc = Object.fromEntries(details.map((detail) => [detail.loc.join("."), detail.code]));
    expect(byLoc).toEqual({
      "body.thresholds.probe_confidence": "less_than_equal",
      "body.thresholds.judge_escalate_below": "greater_than_equal",
      "body.thresholds.label_audit_rate": "float_type",
      "body.budgets.default_max_usd": "greater_than",
      "body.budgets.default_max_minutes": "int_from_float",
      "body.budgets.max_concurrency": "greater_than_equal",
      "body.models.judge.timeout_seconds": "greater_than_equal",
      "body.models.judge.max_usd": "greater_than_equal",
      "body.endpoints.laya_url": "url_scheme",
      "body.endpoints.jev_url": "url_parsing",
    });
  });

  it("rejects a malformed model name with a message the page can show", async () => {
    const response = await patch({ models: { generate: { model: "bad model!" } } });

    expect(response.status).toBe(422);
    const [detail] = (await errorOf(response)).details;
    expect(detail).toMatchObject({
      loc: ["body", "models", "generate", "model"],
      code: "invalid_model",
    });
    expect(detail?.message).toContain("Model names use letters");
  });

  it("rejects unknown groups, unknown leaves, unknown roles and groups that are not objects", async () => {
    const response = await patch({
      notifications: { slack_enabled: true },
      thresholds: { unknown_leaf: 1 },
      models: { stranger: { model: "x" }, judge: { colour: "red" } },
      budgets: 5,
    });

    expect(response.status).toBe(422);
    const details = (await errorOf(response)).details;
    expect(details.map((detail) => [detail.loc.join("."), detail.code])).toEqual(
      expect.arrayContaining([
        ["body.notifications", "extra_forbidden"],
        ["body.thresholds.unknown_leaf", "extra_forbidden"],
        ["body.models.stranger", "extra_forbidden"],
        ["body.models.judge.colour", "extra_forbidden"],
        ["body.budgets", "dict_type"],
      ]),
    );
  });

  it("is admin only", async () => {
    for (const role of ["member", "viewer"] as const) {
      const response = await patch({ thresholds: { probe_confidence: 0.9 } }, role);
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("role_required");
    }
    expect((await readSettings()).overrides).toEqual([]);
  });

  it("returns 422 with the leaf of the patch while the settings_422 fault is set", async () => {
    await controlFaults({ settings_422: true });

    const response = await patch({ thresholds: { probe_confidence: 0.8 } });

    expect(response.status).toBe(422);
    expect((await errorOf(response)).details).toEqual([
      {
        loc: ["body", "thresholds", "probe_confidence"],
        code: "value_error",
        message: "The mock fault settings_422 rejected this value",
      },
    ]);
    expect((await readSettings()).overrides).toEqual([]);

    await controlFaults({ settings_422: null });
    expect((await patch({ thresholds: { probe_confidence: 0.8 } })).status).toBe(200);
  });
});

describe("secrets", () => {
  const put = (name: string, body: unknown, role: "admin" | "member" | "viewer" = "admin") =>
    client.send("PUT", secretPath(name), body, { role });

  it("stores a key write-only: the response, the settings and the mock state never hold it", async () => {
    const response = await put("jev_api_key", { value: TYPED_SECRET });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(TYPED_SECRET);
    const status = JSON.parse(text) as SecretStatus;
    expect(status).toMatchObject({ name: "jev_api_key", has_value: true, source: "db" });
    expect(status.last_set_by).not.toBeNull();
    expect(JSON.stringify(await readSettings())).not.toContain(TYPED_SECRET);
    expect((await readSettings()).secrets.jev_api_key).toEqual(status);
    const heldState = Object.values(mockState.stageFour.settings).map((value) =>
      value instanceof Map ? [...value.entries()] : value,
    );
    expect(JSON.stringify(heldState)).toContain("jev_api_key");
    expect(JSON.stringify(heldState)).not.toContain(TYPED_SECRET);
  });

  it("replaces a key that came from the environment and keeps reporting it as set", async () => {
    const status = (await (
      await put("openai_api_key", { value: TYPED_SECRET })
    ).json()) as SecretStatus;

    expect(status).toMatchObject({ has_value: true, source: "db" });
    expect(status.last_set_at).not.toBeNull();
  });

  it("clears a stored key with 204 and falls back to the environment value when there is one", async () => {
    await put("openai_api_key", { value: TYPED_SECRET });

    const cleared = await client.send("DELETE", secretPath("openai_api_key"));

    expect(cleared.status).toBe(204);
    expect((await readSettings()).secrets.openai_api_key).toMatchObject({
      has_value: true,
      source: "env",
      last_set_at: null,
    });
    const smtp = await client.send("DELETE", secretPath("smtp_password"));
    expect(smtp.status).toBe(204);
    expect((await readSettings()).secrets.smtp_password).toMatchObject({
      has_value: false,
      source: null,
    });
    expect((await client.send("DELETE", secretPath("smtp_password"))).status).toBe(204);
  });

  it("ignores unknown keys of the secret body as the SecretSet schema allows", async () => {
    expect((await put("anthropic_api_key", { value: TYPED_SECRET, other: true })).status).toBe(200);
  });

  it("rejects a missing, empty, mistyped or oversized body without echoing it", async () => {
    const cases: Array<[unknown, string, string]> = [
      [{}, "missing", "value"],
      [{ value: "" }, "string_too_short", "value"],
      [{ value: 42 }, "string_type", "value"],
      [{ value: "x".repeat(4097) }, "string_too_long", "value"],
    ];
    for (const [body, code, field] of cases) {
      const response = await put("anthropic_api_key", body);
      expect(response.status).toBe(422);
      const text = await response.text();
      expect(text).not.toContain(TYPED_SECRET);
      expect(JSON.parse(text).error.details).toEqual([
        expect.objectContaining({ loc: ["body", field], code }),
      ]);
    }
  });

  it("requires an https URL for the Slack webhook without echoing the value", async () => {
    const response = await put("slack_webhook_url", { value: "ftp://hooks.example.test/secret" });

    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).not.toContain("hooks.example.test");
    expect((await readSettings()).secrets.slack_webhook_url?.has_value).toBe(false);
    expect((await put("slack_webhook_url", { value: "https://hooks.example.test/x" })).status).toBe(
      200,
    );
  });

  it("answers 422 on the path for an unknown name", async () => {
    for (const response of [
      await put("github_token", { value: TYPED_SECRET }),
      await client.send("DELETE", secretPath("github_token")),
    ]) {
      expect(response.status).toBe(422);
      expect((await errorOf(response)).details).toEqual([
        expect.objectContaining({ loc: ["path", "name"], code: "enum" }),
      ]);
    }
  });

  it("is admin only for setting and clearing", async () => {
    for (const role of ["member", "viewer"] as const) {
      expect((await put("jev_api_key", { value: TYPED_SECRET }, role)).status).toBe(403);
      expect(
        (await client.send("DELETE", secretPath("smtp_password"), undefined, { role })).status,
      ).toBe(403);
    }
    const settings = await readSettings();
    expect(settings.secrets.jev_api_key?.has_value).toBe(false);
    expect(settings.secrets.smtp_password?.has_value).toBe(true);
  });
});

describe("POST /settings/test/{service}", () => {
  const test = (service: string, role: "admin" | "member" | "viewer" = "admin") =>
    client.send("POST", testPath(service), undefined, { role });

  async function result(service: string): Promise<ServiceTestResult> {
    return (await (await test(service)).json()) as ServiceTestResult;
  }

  it("reports ok with a latency for Laya, Temporal and the providers that have a key", async () => {
    expect(await result("laya")).toEqual({
      service: "laya",
      ok: true,
      latency_ms: 12,
      message: null,
    });
    expect(await result("temporal")).toEqual({
      service: "temporal",
      ok: true,
      latency_ms: 6,
      message: null,
    });
    expect(await result("openai")).toMatchObject({ ok: true, latency_ms: 184 });
    expect(await result("anthropic")).toMatchObject({ ok: true, latency_ms: 212 });
  });

  it("reports not configured when the key or the URL is missing, and for Slack and SMTP until Phase 8", async () => {
    expect(await result("jev")).toEqual({
      service: "jev",
      ok: false,
      latency_ms: null,
      message: "not configured",
    });
    expect(await result("slack")).toMatchObject({ ok: false, message: "not configured" });
    expect(await result("smtp")).toMatchObject({ ok: false, message: "not configured" });
    await client.send("DELETE", secretPath("anthropic_api_key"));
    expect(await result("anthropic")).toMatchObject({ ok: false, message: "not configured" });
  });

  it("tests Jev once both its URL and its key are set", async () => {
    await patch({ endpoints: { jev_url: "https://jev.qa.example.test" } });
    await client.send("PUT", secretPath("jev_api_key"), { value: TYPED_SECRET });

    const outcome = await test("jev");

    const text = await outcome.text();
    expect(text).not.toContain(TYPED_SECRET);
    expect(JSON.parse(text)).toEqual({ service: "jev", ok: true, latency_ms: 95, message: null });
  });

  it("fails the named services while service_test_fail is set and everything with true", async () => {
    await controlFaults({ service_test_fail: ["openai"] });
    expect(await result("openai")).toMatchObject({
      ok: false,
      latency_ms: null,
      message: "The provider answered 401 Unauthorized",
    });
    expect(await result("laya")).toMatchObject({ ok: true });

    await controlFaults({ service_test_fail: true });
    for (const service of ["laya", "openai", "anthropic", "jev", "temporal"]) {
      expect(await result(service)).toMatchObject({ ok: false });
    }
    await controlFaults({ service_test_fail: null });
    expect(await result("laya")).toMatchObject({ ok: true });
  });

  it("follows the dependencies_down fault for Laya and Temporal", async () => {
    await controlFaults({ dependencies_down: ["laya"] });

    expect(await result("laya")).toMatchObject({
      ok: false,
      message: "Connection refused by Laya",
    });
    expect(await result("temporal")).toMatchObject({ ok: true });
  });

  it("is slowed by health_slow", async () => {
    await controlFaults({ health_slow: 250 });
    const started = Date.now();

    await test("laya");

    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
  });

  it("answers 422 on the path for an unknown service and is admin only", async () => {
    const unknown = await test("github");
    expect(unknown.status).toBe(422);
    expect((await errorOf(unknown)).details).toEqual([
      expect.objectContaining({ loc: ["path", "service"], code: "enum" }),
    ]);
    for (const role of ["member", "viewer"] as const) {
      expect((await test("laya", role)).status).toBe(403);
    }
  });
});

describe("POST /__mock/stage4/seed with settings", () => {
  const seed = (body: unknown) =>
    fetch(`${running.baseUrl}/__mock/stage4/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("seeds overrides that show source db and the dotted override paths", async () => {
    const response = await seed({ settings: "overridden" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ settings: "overridden" });
    const settings = await readSettings();
    expect(settings.overrides).toEqual([
      "budgets.default_max_usd",
      "endpoints.jev_url",
      "models.judge.effort",
      "models.judge.max_usd",
      "thresholds.probe_confidence",
    ]);
    expect(settings.models.judge?.source).toBe("db");
    expect(settings.endpoints.jev_url).toBe("https://jev.qa.example.test");
  });

  it("seeds a state with no key at all", async () => {
    await seed({ settings: "unconfigured" });

    const settings = await readSettings();
    expect(Object.values(settings.secrets).map((secret) => secret.has_value)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("goes back to the defaults with the default seed and with a state reset", async () => {
    await seed({ settings: "overridden" });
    await seed({ settings: "default" });
    expect((await readSettings()).overrides).toEqual([]);

    await patch({ thresholds: { probe_confidence: 0.9 } });
    mockState.reset();
    expect((await readSettings()).overrides).toEqual([]);
  });

  it("rejects an unknown seed, an unknown key and an empty body", async () => {
    expect((await seed({ settings: "mystery" })).status).toBe(422);
    expect((await seed({ other: true })).status).toBe(422);
    expect((await seed({})).status).toBe(422);
  });
});
