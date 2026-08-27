import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { Clock } from "../src/client";
import type { ServerConfig } from "../src/config";
import { Redactor } from "../src/redact";
import { createTessaServer } from "../src/server";
import { TOOLS } from "../src/tools";
import { executeTool } from "../src/tools/define";
import {
  BASE_URL,
  IDS,
  TOKEN,
  agentSession,
  bundle,
  bundleDiff,
  bundleSummary,
  coverageMap,
  environment,
  errorBody,
  explanationCreated,
  finding,
  findingSummary,
  healthReport,
  planFixture,
  promptIssue,
  proposal,
  proposalItem,
  repro,
  run,
  runDiff,
  runScenarioDetail,
  runScenarioSummaries,
  runStats,
  scenarioSummary,
  step,
  target,
  targetSummary,
  user,
  validationReport,
} from "./fixtures";

export type SeenRequest = {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
};

export const seen: SeenRequest[] = [];

const API = `${BASE_URL}/api/v1`;

const here = dirname(fileURLToPath(import.meta.url));
export const PROPOSAL_SCHEMA_TEXT = readFileSync(resolve(here, "..", "..", "..", "schemas", "proposal.v1.json"), "utf8");

export const defaultHandlers = [
  http.get(`${API}/users/me`, () => HttpResponse.json(user)),
  http.get(`${API}/targets`, () =>
    HttpResponse.json({ items: [targetSummary], next_cursor: null, total: null }),
  ),
  http.get(`${API}/targets/:targetId`, () => HttpResponse.json(target)),
  http.get(`${API}/targets/:targetId/bundles`, () =>
    HttpResponse.json({ items: [bundleSummary], next_cursor: null, total: null }),
  ),
  http.get(`${API}/targets/:targetId/environment`, () => HttpResponse.json(environment)),
  http.patch(`${API}/targets/:targetId/environment`, () =>
    HttpResponse.json({
      ...environment,
      missing_required: 0,
      items: environment.items.map((item) => ({ ...item, has_value: true })),
    }),
  ),
  http.post(`${API}/targets/:targetId/health-checks`, () => HttpResponse.json(healthReport)),
  http.get(`${API}/targets/:targetId/proposal`, () =>
    HttpResponse.json(errorBody("not_found", "No proposal"), { status: 404 }),
  ),
  http.get(`${BASE_URL}/schemas/proposal.v1.json`, () =>
    new HttpResponse(PROPOSAL_SCHEMA_TEXT, { headers: { "content-type": "application/schema+json" } }),
  ),
  http.put(`${API}/targets/:targetId/proposal`, () => HttpResponse.json({ ...proposal, source: "put" })),
  http.patch(`${API}/proposal-items/:itemId`, async ({ request }) => {
    const body = (await request.json()) as { status: string; note?: string | null };
    return HttpResponse.json(proposalItem(1, { status: body.status, note: body.note ?? null }));
  }),
  http.post(`${API}/targets/:targetId/proposal/plan`, () => HttpResponse.json(planFixture, { status: 201 })),
  http.get(`${API}/coverage`, () => HttpResponse.json(coverageMap(3))),
  http.post(`${API}/scenarios/validate`, () => HttpResponse.json({ valid: true, errors: [], warnings: [] })),
  http.get(`${API}/scenarios`, () =>
    HttpResponse.json({ items: [scenarioSummary(0), scenarioSummary(1)], next_cursor: null, total: null }),
  ),
  http.post(`${API}/targets/:targetId/prompt-issues`, () =>
    HttpResponse.json(promptIssue, { status: 201 }),
  ),
  http.post(`${API}/bundles/validate`, () => HttpResponse.json(validationReport)),
  http.post(`${API}/bundles`, () =>
    HttpResponse.json({ bundle, created: true, dry_run_run_id: IDS.run }, { status: 201 }),
  ),
  http.get(`${API}/bundles/:bundleId`, () => HttpResponse.json(bundle)),
  http.get(`${API}/bundles/:bundleId/diff`, () => HttpResponse.json(bundleDiff)),
  http.post(`${API}/runs`, () =>
    HttpResponse.json(
      {
        run_id: IDS.run,
        status: "queued",
        kind: "suite",
        workflow_id: "wf-1",
        created_at: "2026-10-08T10:00:00Z",
      },
      { status: 202 },
    ),
  ),
  http.get(`${API}/runs/:runId`, () => HttpResponse.json(run("completed"))),
  http.get(`${API}/runs/:runId/stats`, () => HttpResponse.json(runStats)),
  http.get(`${API}/runs/:runId/scenarios`, () =>
    HttpResponse.json({ items: runScenarioSummaries, next_cursor: null, total: 2 }),
  ),
  http.get(`${API}/run-scenarios/:id`, () => HttpResponse.json(runScenarioDetail)),
  http.get(`${API}/runs/:runId/diff`, () => HttpResponse.json(runDiff)),
  http.post(`${API}/runs/:runId/cancel`, () => HttpResponse.json(run("canceling"), { status: 202 })),
  http.get(`${API}/steps/:stepId`, () => HttpResponse.json(step())),
  http.get(`${API}/findings`, () =>
    HttpResponse.json({ items: [findingSummary], next_cursor: null, total: null }),
  ),
  http.get(`${API}/findings/:findingId`, () => HttpResponse.json(finding)),
  http.get(`${API}/findings/:findingId/repro`, () => HttpResponse.json(repro(3))),
  http.post(`${API}/findings/:findingId/explanations`, () =>
    HttpResponse.json(explanationCreated, { status: 201 }),
  ),
  http.patch(`${API}/findings/:findingId`, async ({ request }) => {
    const body = (await request.json()) as { status: string };
    return HttpResponse.json({ ...finding, status: body.status });
  }),
  http.post(`${API}/agent-sessions`, () => HttpResponse.json(agentSession, { status: 201 })),
  http.patch(`${API}/agent-sessions/:sessionId`, () => HttpResponse.json(agentSession)),
];

export const mswServer = setupServer(...defaultHandlers);

mswServer.events.on("request:start", ({ request }) => {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  seen.push({ method: request.method, path: url.pathname, search: url.search, headers });
});

export function resetSeen(): void {
  seen.length = 0;
}

export function requestsTo(method: string, path: string): SeenRequest[] {
  return seen.filter((entry) => entry.method === method && entry.path === `/api/v1${path}`);
}

export type FakeClock = Clock & { elapsed: () => number; sleeps: number[] };

export function createFakeClock(): FakeClock {
  let current = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      current += milliseconds;
    },
    elapsed: () => current - 1_000_000,
    sleeps,
  };
}

export type Harness = ReturnType<typeof createHarness>;

export type HarnessOptions = {
  config?: Partial<ServerConfig>;
  cwd?: string;
  fetchImpl?: typeof fetch;
};

export function createHarness(options: HarnessOptions = {}) {
  let counter = 0;
  const generateId = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
  const clock = createFakeClock();
  const redactor = new Redactor();
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const config: ServerConfig = {
    baseUrl: BASE_URL,
    token: TOKEN,
    problem: null,
    cwd: options.cwd ?? "C:\\work\\hotel-app",
    claudeSessionId: "claude-session-1",
    ...options.config,
  };
  const tessa = createTessaServer({
    config,
    pluginVersion: "0.1.0",
    logger: (message, fields) => logs.push({ message, fields }),
    redactor,
    clock,
    generateId,
    fetchImpl: options.fetchImpl,
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const definition = TOOLS.find((tool) => tool.name === name);
    if (definition === undefined) {
      throw new Error(`unknown tool ${name}`);
    }
    const result = await executeTool(definition, tessa.context, args);
    const text = result.content[0]?.text ?? "";
    return {
      isError: result.isError === true,
      text,
      body: JSON.parse(text) as Record<string, any>,
    };
  }

  return { ...tessa, config, clock, redactor, logs, call, generateId };
}
