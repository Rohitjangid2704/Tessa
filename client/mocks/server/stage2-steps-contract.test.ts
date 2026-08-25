import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerStepFixtureGroup, unregisterStepFixtureGroup } from "@/mocks/fixtures/steps";
import type { RunningMockServer } from "@/mocks/server/http";
import { fixtureStepId } from "@/mocks/stage2/seed-ids";
import { mockState } from "@/mocks/state";
import type { RunScenario, Step } from "@/lib/api/types";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage2Client,
  errorOf,
  STAGE_TWO_IDS,
  type Stage2Client,
} from "@/tests/utils/stage2";

let running: RunningMockServer;
let client: Stage2Client;

beforeAll(async () => {
  running = await startMockApi();
  client = createStage2Client(running.baseUrl);
});

afterAll(async () => {
  mockState.reset();
  await running.close();
});

beforeEach(() => {
  mockState.reset();
});

const IDS = STAGE_TWO_IDS.steps;

async function step(name: string): Promise<Step> {
  const id = IDS[name];
  expect(id, name).toBeDefined();
  const response = await client.get(`/api/v1/steps/${id}`);
  expect(response.status, name).toBe(200);
  return (await response.json()) as Step;
}

describe("GET /steps/{id} fixtures", () => {
  it("serves one fixture for every StepRequest and StepResponse kind", async () => {
    const http = await step("httpJson");
    expect(http.adapter).toBe("http");
    expect(http.request).toMatchObject({ kind: "http", method: "GET" });
    expect(http.response).toMatchObject({ kind: "http", status: 200 });
    expect(http.artifacts).toEqual([]);
    expect(http.tier0).toEqual({ passed: true, failures: [] });

    const sse = await step("sseAnswer");
    expect(sse.adapter).toBe("sse");
    expect(sse.request).toMatchObject({ kind: "sse", method: "POST" });
    expect(sse.response).toMatchObject({ kind: "sse", status: 200, closed_by: "server" });
    if (sse.response?.kind === "sse") {
      expect(sse.response.events.at(-1)?.event).toBe("done");
      expect(sse.response.events.map((event) => event.at_ms)).toEqual(
        [...sse.response.events.map((event) => event.at_ms)].sort((left, right) => left - right),
      );
    }
    expect(sse.ask).toBe("Which maintenance issues are still open?");
    expect(sse.answer).toContain("7 maintenance issues");
    expect(sse.tools).toEqual([
      {
        name: "list_maintenance_issues",
        args: { status: "open", limit: 20 },
        result_summary: "7 rows",
      },
    ]);
    expect(sse.cards).toHaveLength(1);

    const browser = await step("browserNavigate");
    expect(browser.adapter).toBe("browser");
    expect(browser.request).toMatchObject({ kind: "browser", action: "navigate" });
    expect(browser.response).toMatchObject({ kind: "browser", title: "Sign in | Gracie" });
  });

  it("carries the full Step field set with declared Stage 3 and 4 fields empty", async () => {
    const full = await step("sseAnswer");
    expect(Object.keys(full).sort()).toEqual(
      [
        "adapter",
        "answer",
        "artifacts",
        "ask",
        "attempt",
        "cards",
        "cost_usd",
        "db_checks",
        "evidence",
        "finished_at",
        "gold_points",
        "id",
        "index",
        "judge",
        "label",
        "latency_ms",
        "payload_purged",
        "probes",
        "request",
        "response",
        "response_truncated",
        "run_id",
        "run_scenario_id",
        "started_at",
        "tier0",
        "tools",
        "verdict",
      ].sort(),
    );
    expect(full).toMatchObject({
      gold_points: [],
      db_checks: [],
      probes: [],
      judge: null,
      evidence: null,
      verdict: null,
      cost_usd: 0,
      run_id: STAGE_TWO_IDS.runs.showcase,
    });
  });

  it("flags a truncated response and a purged payload", async () => {
    const truncated = await step("httpTruncated");
    expect(truncated.response_truncated).toBe(true);
    expect(truncated.payload_purged).toBe(false);
    expect(truncated.response).not.toBeNull();
    const sseTruncated = await step("sseTruncated");
    expect(sseTruncated.response_truncated).toBe(true);

    const purged = await step("httpPurged");
    expect(purged).toMatchObject({
      payload_purged: true,
      request: null,
      response: null,
      response_truncated: false,
    });
  });

  it("serves tools, cards and Tier-0 failures", async () => {
    const failures = await step("sseTier0Failures");
    expect(failures.tier0.passed).toBe(false);
    expect(failures.tier0.failures.map((failure) => failure.check)).toEqual([
      "text_contains",
      "tools",
      "internal_ids",
      "cards",
    ]);
    const server = await step("httpServerError");
    expect(server.tier0.failures.map((failure) => failure.check)).toEqual([
      "status",
      "fields",
      "latency",
    ]);
    const timeout = await step("sseTimeout");
    expect(timeout).toMatchObject({ response: { closed_by: "timeout" } });
    const missing = await step("browserMissingElement");
    const summary = await findSummary(missing.run_scenario_id, missing.id);
    expect(summary.ok).toBe(false);
  });

  it("gives browser steps screenshots, a recording and a trace but API steps none", async () => {
    const click = await step("browserClick");
    const kinds = click.artifacts.map((artifact) => artifact.kind);
    expect(kinds.filter((kind) => kind === "screenshot")).toHaveLength(2);
    expect(kinds).toContain("recording");
    expect(kinds).toContain("trace");
    for (const artifact of click.artifacts) {
      expect(artifact.url).toMatch(/^\/api\/v1\/artifacts\/.+\..+/);
      expect(artifact.size_bytes).toBeGreaterThan(0);
      expect(Date.parse(artifact.expires_at) - Date.now()).toBeGreaterThan(890_000);
      expect(Date.parse(artifact.expires_at) - Date.now()).toBeLessThanOrEqual(900_000);
    }
    const mimes = Object.fromEntries(
      click.artifacts.map((artifact) => [artifact.kind, artifact.mime]),
    );
    expect(mimes).toMatchObject({
      screenshot: "image/png",
      recording: "video/webm",
      trace: "application/zip",
    });
    for (const name of ["httpJson", "sseAnswer", "httpServerError"]) {
      expect((await step(name)).artifacts).toEqual([]);
    }
  });

  it("keeps secrets as ${NAME} placeholders in recorded requests", async () => {
    const http = await step("httpJson");
    expect(http.request).toMatchObject({
      headers: { Authorization: "Bearer ${GRACIE_ADMIN_TOKEN}" },
    });
    const typed = await step("browserType");
    expect(typed.request).toMatchObject({ text: "${GRACIE_GUEST_EMAIL}" });
  });

  it("answers 404 for an unknown step, 422 for a malformed id and is open to the viewer", async () => {
    const unknown = await client.get("/api/v1/steps/0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff");
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe("not_found");
    expect((await client.get("/api/v1/steps/zzz")).status).toBe(422);
    const viewer = await client.get(`/api/v1/steps/${IDS.httpJson}`, "viewer");
    expect(viewer.status).toBe(200);
  });
});

async function findSummary(runScenarioId: string, stepId: string) {
  const detail = (await (
    await client.get(`/api/v1/run-scenarios/${runScenarioId}`)
  ).json()) as RunScenario;
  const summary = detail.steps.find((candidate) => candidate.id === stepId);
  expect(summary).toBeDefined();
  return summary as RunScenario["steps"][number];
}

describe("step fixture registration point", () => {
  const freeCell = {
    feature_id: "reports.read.occupancy_summary",
    role: "manager",
    interface_id: "rest_api",
  };

  it("adds a registered group to the showcase run at the next seed, with stable ids", async () => {
    const content = {
      adapter: "http" as const,
      label: "GET /reports/occupancy",
      request: null,
      response: null,
      response_truncated: false,
      payload_purged: true,
      ask: null,
      answer: null,
      tools: [],
      cards: [],
      latency_ms: 10,
      cost_usd: 0,
      tier0: { passed: true, failures: [] },
      ok: true,
      artifacts: [],
      verdict: null,
      gold_points: [
        {
          key: "occupancy",
          value: 82,
          oracle_result_id: STAGE_TWO_IDS.runs.completed,
          rendered: "82%",
        },
      ],
    };
    registerStepFixtureGroup({
      key: "truth-test",
      cell: freeCell,
      attempts: [{ outcome: "pass", steps: [{ name: "occupancy", content }] }],
    });
    try {
      await client.control.seed("gracie");
      const id = fixtureStepId("truth-test", "occupancy");
      const response = await client.get(`/api/v1/steps/${id}`);
      expect(response.status).toBe(200);
      const loaded = (await response.json()) as Step;
      expect(loaded.gold_points).toHaveLength(1);
      expect(loaded.run_id).toBe(STAGE_TWO_IDS.runs.showcase);
    } finally {
      unregisterStepFixtureGroup("truth-test");
    }
  });

  it("refuses two groups on the same cell", () => {
    expect(() =>
      registerStepFixtureGroup({
        key: "clash",
        cell: {
          feature_id: "smart_log.read.open_maintenance",
          role: "guest",
          interface_id: "chat_sse",
        },
        attempts: [],
      }),
    ).toThrow(/uses the cell of group chat/);
  });
});

describe("steps of simulated runs", () => {
  it("records steps for every attempt and agrees with the run scenario summaries", async () => {
    await client.control.clock({ speed: 1000 });
    const handle = await client.startInlineRun({ k: 2, roles: ["guest"] });
    await client.runToEnd(handle.run_id);
    const scenarios = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/scenarios`)
    ).json()) as { items: Array<{ id: string }> };
    expect(scenarios.items).toHaveLength(2);
    for (const item of scenarios.items) {
      const detail = (await (
        await client.get(`/api/v1/run-scenarios/${item.id}`)
      ).json()) as RunScenario;
      expect(new Set(detail.steps.map((summary) => summary.attempt))).toEqual(new Set([0, 1]));
      for (const summary of detail.steps) {
        const full = (await (await client.get(`/api/v1/steps/${summary.id}`)).json()) as Step;
        expect(full).toMatchObject({
          run_id: handle.run_id,
          run_scenario_id: item.id,
          attempt: summary.attempt,
          index: summary.index,
          label: summary.label,
          adapter: summary.adapter,
        });
        expect(summary.tier0_failure_count).toBe(full.tier0.failures.length);
        expect(summary.screenshot_count).toBe(
          full.artifacts.filter((artifact) => artifact.kind === "screenshot").length,
        );
      }
    }
  });

  it("gives deterministic step ids: the same plan on a fresh state yields the same ids", async () => {
    await client.control.clock({ speed: 1000 });
    const idsOf = async () => {
      const handle = await client.startInlineRun({ roles: ["guest"] });
      await client.runToEnd(handle.run_id);
      const scenarios = (await (
        await client.get(`/api/v1/runs/${handle.run_id}/scenarios`)
      ).json()) as { items: Array<{ id: string }> };
      const ids: string[] = [];
      for (const item of scenarios.items) {
        const detail = (await (
          await client.get(`/api/v1/run-scenarios/${item.id}`)
        ).json()) as RunScenario;
        ids.push(...detail.steps.map((summary) => summary.id));
      }
      return ids;
    };
    const first = await idsOf();
    mockState.reset();
    await client.control.clock({ speed: 1000 });
    expect(await idsOf()).toEqual(first);
  });
});
