import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Label,
  LabelTaskPage,
  OracleTemplatePage,
  Run,
  RunScenarioPage,
  RunSummaryPage,
  Step,
} from "@/lib/api/types";
import { ORACLE_RESULT_IDS, ORACLE_TEMPLATE_IDS } from "@/mocks/fixtures/oracle-templates";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import { createContractValidator, type ContractCheck } from "@/tests/utils/contract";
import {
  createStage2Client,
  GRACIE_ID,
  STAGE_ONE_IDS,
  STAGE_TWO_IDS,
  type Role,
  type Stage2Client,
} from "@/tests/utils/stage2";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Caller = Role | "anonymous";

interface Exchange {
  method: Method;
  template: string;
  params?: Record<string, string>;
  query?: string;
  body?: unknown;
  invalidBody?: boolean | "format";
  as?: Caller;
  headers?: Record<string, string>;
  status: number;
}

interface Result {
  response: Response;
  json: unknown;
}

vi.setConfig({ testTimeout: 120_000 });

const MISSING_ID = "0198f6f2-4c2a-7d10-9c1e-000000000000";
const SETTLE_WAIT_MS = 450;

const STAGE_PATH_PATTERNS = [
  /^\/api\/v1\/plans/,
  /^\/api\/v1\/scenarios/,
  /^\/api\/v1\/runs/,
  /^\/api\/v1\/run-scenarios/,
  /^\/api\/v1\/steps/,
  /^\/api\/v1\/artifacts/,
  /^\/api\/v1\/feeds/,
  /^\/api\/v1\/seeds/,
  /^\/api\/v1\/targets\/\{target_id\}\/seeds/,
  /^\/api\/v1\/oracle-/,
  /^\/api\/v1\/probes/,
  /^\/api\/v1\/settings/,
  /^\/api\/v1\/labels/,
];

const SKIPPED_OPERATIONS: Readonly<Record<string, string>> = {
  "GET /api/v1/targets/{target_id}/seeds": "the seeds mock handlers do not exist yet (fe-p3-seeds)",
  "POST /api/v1/targets/{target_id}/seeds/verify":
    "the seeds mock handlers do not exist yet (fe-p3-seeds)",
  "POST /api/v1/targets/{target_id}/seeds/reset":
    "the seeds mock handlers do not exist yet (fe-p3-seeds)",
  "GET /api/v1/seeds/{seed_id}": "the seeds mock handlers do not exist yet (fe-p3-seeds)",
};

const contract = createContractValidator();
const covered = new Set<string>();

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

beforeEach(async () => {
  mockState.reset();
  await client.control.clock({ speed: 1000 });
});

function fill(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`no value for {${name}} in ${template}`);
    }
    return encodeURIComponent(value);
  });
}

function expectConforming(check: ContractCheck, label: string): void {
  expect(check.errors, label).toEqual([]);
  expect(check.valid, label).toBe(true);
}

async function exchange(spec: Exchange): Promise<Result> {
  const label = `${spec.method} ${spec.template}`;
  const path = fill(spec.template, spec.params ?? {});
  if (spec.body !== undefined) {
    const request = contract.checkRequestBody(spec.method, spec.template, spec.body);
    if (spec.invalidBody === "format") {
      expect(request.valid, `${label} format-only fixture: ${JSON.stringify(spec.body)}`).toBe(
        true,
      );
    } else if (spec.invalidBody === true) {
      expect(
        request.valid,
        `${label} fixture must break the request schema: ${JSON.stringify(spec.body)}`,
      ).toBe(false);
    } else {
      expectConforming(request, `${label} request body ${JSON.stringify(spec.body)}`);
    }
  }
  const caller = spec.as ?? "admin";
  const authorization = caller === "anonymous" ? {} : await client.headers(caller);
  const response = await fetch(`${running.baseUrl}${path}${spec.query ? `?${spec.query}` : ""}`, {
    method: spec.method,
    headers: {
      ...authorization,
      ...(spec.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...spec.headers,
    },
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
  });
  const text = await response.text();
  expect(response.status, `${label} answered ${response.status}: ${text.slice(0, 300)}`).toBe(
    spec.status,
  );
  expect(
    contract.responseStatuses(spec.method, spec.template),
    `${label} must declare a ${spec.status} response`,
  ).toContain(String(spec.status));
  covered.add(label);
  if (spec.status === 204) {
    expect(text, `${label} 204 body`).toBe("");
    return { response, json: null };
  }
  const json: unknown = JSON.parse(text);
  expectConforming(
    contract.checkResponse(spec.method, spec.template, spec.status, json),
    `${label} ${spec.status} response`,
  );
  return { response, json };
}

function seededStep(name: string): string {
  const id = STAGE_TWO_IDS.steps[name];
  if (id === undefined) {
    throw new Error(`no seeded step ${name}`);
  }
  return id;
}

function key(): Record<string, string> {
  return { "Idempotency-Key": crypto.randomUUID() };
}

async function settleAll(): Promise<void> {
  await client.control.settle();
}

describe("Stage 2: plans", () => {
  it("previews, creates, lists, reads, updates and deletes a plan", async () => {
    const body = client.planBody({ saved: true, name: "Conformance plan" });
    await exchange({ method: "POST", template: "/api/v1/plans/preview", body, status: 200 });
    await exchange({
      method: "POST",
      template: "/api/v1/plans/preview",
      body: client.planBody({ selection: { feature_ids: [], area_ids: [], roles: [] } }),
      status: 200,
    });
    const created = await exchange({
      method: "POST",
      template: "/api/v1/plans",
      body,
      headers: key(),
      status: 201,
    });
    const plan = created.json as { id: string };
    await exchange({
      method: "GET",
      template: "/api/v1/plans",
      query: `target_id=${GRACIE_ID}&saved=true&limit=2&include_total=true&sort=-created_at`,
      status: 200,
    });
    await exchange({ method: "GET", template: "/api/v1/plans", status: 200 });
    for (const id of Object.values(STAGE_TWO_IDS.plans).concat(plan.id)) {
      await exchange({
        method: "GET",
        template: "/api/v1/plans/{plan_id}",
        params: { plan_id: id },
        status: 200,
      });
      await exchange({
        method: "GET",
        template: "/api/v1/plans/{plan_id}/cells",
        params: { plan_id: id },
        query: "limit=5&include_total=true",
        status: 200,
      });
    }
    await exchange({
      method: "GET",
      template: "/api/v1/plans/{plan_id}/cells",
      params: { plan_id: STAGE_TWO_IDS.plans.smartLog },
      query:
        "status=empty&status=generated&feature_id=smart_log.read.open_maintenance&sort=-status",
      status: 200,
    });
    await exchange({
      method: "PATCH",
      template: "/api/v1/plans/{plan_id}",
      params: { plan_id: plan.id },
      body: { name: "Renamed", selection: client.selection({ k: 2 }) },
      status: 200,
    });
    await exchange({
      method: "PATCH",
      template: "/api/v1/plans/{plan_id}",
      params: { plan_id: plan.id },
      body: { name: null },
      status: 200,
    });
    await exchange({
      method: "DELETE",
      template: "/api/v1/plans/{plan_id}",
      params: { plan_id: plan.id },
      status: 204,
    });
  });

  it("answers the declared errors with an ErrorResponse", async () => {
    const plan = { plan_id: STAGE_TWO_IDS.plans.smartLog };
    await exchange({
      method: "GET",
      template: "/api/v1/plans/{plan_id}",
      params: { plan_id: MISSING_ID },
      status: 404,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/plans/{plan_id}",
      params: { plan_id: "not-a-uuid" },
      status: 422,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/plans/{plan_id}",
      params: plan,
      as: "anonymous",
      status: 401,
    });
    await exchange({
      method: "DELETE",
      template: "/api/v1/plans/{plan_id}",
      params: plan,
      as: "viewer",
      status: 403,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/plans",
      query: "unknown=1",
      status: 422,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/plans/preview",
      body: client.planBody({ target_id: MISSING_ID }),
      status: 404,
    });
  });

  it("rejects the bodies the request schema rejects", async () => {
    const valid = client.planBody();
    await exchange({
      method: "POST",
      template: "/api/v1/plans/preview",
      body: { ...valid, target_id: "not-a-uuid" },
      invalidBody: "format",
      status: 422,
    });
    const invalidBodies: unknown[] = [
      { ...valid, saved: "yes" },
      { target_id: GRACIE_ID, saved: false },
      { ...valid, selection: { ...valid.selection, k: 11 } },
      { ...valid, selection: { ...valid.selection, k: 0 } },
      { ...valid, selection: { ...valid.selection, interface_mode: "sideways" } },
      { ...valid, selection: { ...valid.selection, depth: "exhaustive" } },
      { ...valid, selection: { ...valid.selection, feature_ids: "x" } },
      { ...valid, selection: { ...valid.selection, budget: { max_usd: -1, max_minutes: 0 } } },
      { ...valid, name: "" },
    ];
    for (const body of invalidBodies) {
      await exchange({
        method: "POST",
        template: "/api/v1/plans/preview",
        body,
        invalidBody: true,
        status: 422,
      });
    }
    for (const body of [{ name: "" }, { name: 3 }, { selection: { k: 1 } }]) {
      await exchange({
        method: "PATCH",
        template: "/api/v1/plans/{plan_id}",
        params: { plan_id: STAGE_TWO_IDS.plans.smartLog },
        body,
        invalidBody: true,
        status: 422,
      });
    }
  });
});

describe("Stage 2: scenarios", () => {
  it("lists and reads every kind of scenario", async () => {
    const page = (
      await exchange({
        method: "GET",
        template: "/api/v1/scenarios",
        query: `target_id=${GRACIE_ID}&include_synthetic=true&limit=200&include_total=true`,
        status: 200,
      })
    ).json as { items: Array<{ id: string }> };
    expect(page.items.length).toBeGreaterThan(60);
    for (const query of [
      "status=invalid",
      "status=accepted&status=in_review&origin=authored&origin=generated",
      "family=smart-log&feature_id=smart_log.read.open_maintenance",
      "q=login&sort=-updated_at",
      `plan_id=${STAGE_TWO_IDS.plans.smartLog}`,
      "include_synthetic=false&limit=3&sort=title",
    ]) {
      await exchange({ method: "GET", template: "/api/v1/scenarios", query, status: 200 });
    }
    for (const item of page.items) {
      await exchange({
        method: "GET",
        template: "/api/v1/scenarios/{scenario_id}",
        params: { scenario_id: item.id },
        status: 200,
      });
    }
    await exchange({
      method: "GET",
      template: "/api/v1/scenarios/{scenario_id}",
      params: { scenario_id: MISSING_ID },
      status: 404,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/scenarios",
      query: "origin=nonsense",
      status: 422,
    });
  });
});

describe("Stage 2: runs, run scenarios and steps of the seeded history", () => {
  it("reads every seeded run down to its steps and events", async () => {
    await client.control.productionTarget();
    const list = (
      await exchange({
        method: "GET",
        template: "/api/v1/runs",
        query: `target_id=${GRACIE_ID}&limit=50&include_total=true`,
        status: 200,
      })
    ).json as RunSummaryPage;
    expect(list.items.length).toBeGreaterThanOrEqual(6);
    for (const query of [
      "status=completed&status=failed&kind=suite",
      `plan_id=${STAGE_TWO_IDS.plans.smartLog}`,
      "created_after=2020-01-01T00:00:00Z&created_before=2099-01-01T00:00:00Z&sort=-created_at",
      `run_group_id=${MISSING_ID}`,
    ]) {
      await exchange({ method: "GET", template: "/api/v1/runs", query, status: 200 });
    }
    const stepIds = new Set<string>();
    for (const runId of Object.values(STAGE_TWO_IDS.runs)) {
      const run = (
        await exchange({
          method: "GET",
          template: "/api/v1/runs/{run_id}",
          params: { run_id: runId },
          status: 200,
        })
      ).json as Run;
      expect(run.id).toBe(runId);
      const scenarios = (
        await exchange({
          method: "GET",
          template: "/api/v1/runs/{run_id}/scenarios",
          params: { run_id: runId },
          query: "limit=200&include_total=true",
          status: 200,
        })
      ).json as RunScenarioPage;
      for (const scenario of scenarios.items) {
        const detail = (
          await exchange({
            method: "GET",
            template: "/api/v1/run-scenarios/{run_scenario_id}",
            params: { run_scenario_id: scenario.id },
            status: 200,
          })
        ).json as { steps: Array<{ id: string }> };
        for (const step of detail.steps) {
          stepIds.add(step.id);
        }
      }
      await exchange({
        method: "GET",
        template: "/api/v1/runs/{run_id}/browser-sessions",
        params: { run_id: runId },
        status: 200,
      });
      await exchange({
        method: "GET",
        template: "/api/v1/runs/{run_id}/browser-sessions",
        params: { run_id: runId },
        query: "status=ended&status=active",
        status: 200,
      });
      const events = (await client.getEvents(runId)) as Array<Record<string, unknown>>;
      for (const event of events) {
        expectConforming(
          contract.checkSchema("StreamEvent", event),
          `${runId} event ${String(event.type)}#${String(event.seq)}`,
        );
      }
    }
    for (const stepId of [...stepIds, ...Object.values(STAGE_TWO_IDS.steps)]) {
      await exchange({
        method: "GET",
        template: "/api/v1/steps/{step_id}",
        params: { step_id: stepId },
        status: 200,
      });
    }
    expect(stepIds.size).toBeGreaterThan(100);
  });

  it("filters run scenarios and pages the event log", async () => {
    const runId = STAGE_TWO_IDS.runs.flaky;
    await exchange({
      method: "GET",
      template: "/api/v1/runs/{run_id}/scenarios",
      params: { run_id: runId },
      query:
        "status=finished&status=skipped&verdict=pass&verdict=flaky&family=smart-log&role=guest&sort=-status,role",
      status: 200,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/runs/{run_id}/events",
      params: { run_id: runId },
      query: "after_seq=3&limit=5&order=asc&type=scenario.queued",
      status: 200,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/runs/{run_id}/events",
      params: { run_id: runId },
      query: "before_seq=40&limit=5&order=desc",
      status: 200,
    });
  });

  it("answers the declared errors for runs, run scenarios and steps", async () => {
    for (const [template, name] of [
      ["/api/v1/runs/{run_id}", "run_id"],
      ["/api/v1/runs/{run_id}/scenarios", "run_id"],
      ["/api/v1/runs/{run_id}/browser-sessions", "run_id"],
      ["/api/v1/run-scenarios/{run_scenario_id}", "run_scenario_id"],
      ["/api/v1/steps/{step_id}", "step_id"],
    ] as const) {
      await exchange({ method: "GET", template, params: { [name]: MISSING_ID }, status: 404 });
      await exchange({ method: "GET", template, params: { [name]: "nope" }, status: 422 });
      await exchange({
        method: "GET",
        template,
        params: { [name]: MISSING_ID },
        as: "anonymous",
        status: 401,
      });
    }
    await exchange({
      method: "GET",
      template: "/api/v1/runs",
      query: "status=teleporting",
      status: 422,
    });
    await exchange({ method: "GET", template: "/api/v1/runs", query: "bogus=1", status: 422 });
  });
});

describe("Stage 2: starting and canceling runs", () => {
  it("starts a run from a saved plan and from an inline plan, then reads it live and finished", async () => {
    await client.control.hold("first_step");
    const fromPlan = (
      await exchange({
        method: "POST",
        template: "/api/v1/runs",
        body: { plan_id: STAGE_TWO_IDS.plans.guestFlows, max_concurrency: 2, reset_seed: false },
        headers: key(),
        status: 202,
      })
    ).json as { run_id: string };
    const inline = (
      await exchange({
        method: "POST",
        template: "/api/v1/runs",
        body: {
          plan: client.planBody({
            selection: {
              feature_ids: ["guest_requests.flow.request_and_track"],
              roles: ["guest"],
              interface_mode: "browser_only",
            },
          }),
        },
        headers: key(),
        status: 202,
      })
    ).json as { run_id: string };
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
    for (const runId of [fromPlan.run_id, inline.run_id]) {
      await exchange({
        method: "GET",
        template: "/api/v1/runs/{run_id}",
        params: { run_id: runId },
        status: 200,
      });
      const scenarios = (
        await exchange({
          method: "GET",
          template: "/api/v1/runs/{run_id}/scenarios",
          params: { run_id: runId },
          status: 200,
        })
      ).json as RunScenarioPage;
      for (const scenario of scenarios.items) {
        await exchange({
          method: "GET",
          template: "/api/v1/run-scenarios/{run_scenario_id}",
          params: { run_scenario_id: scenario.id },
          status: 200,
        });
      }
      await exchange({
        method: "GET",
        template: "/api/v1/runs/{run_id}/browser-sessions",
        params: { run_id: runId },
        status: 200,
      });
    }
    const canceled = await exchange({
      method: "POST",
      template: "/api/v1/runs/{run_id}/cancel",
      params: { run_id: fromPlan.run_id },
      status: 202,
    });
    expect((canceled.json as Run).status).toBe("canceling");
    await exchange({
      method: "POST",
      template: "/api/v1/runs/{run_id}/cancel",
      params: { run_id: fromPlan.run_id },
      as: "viewer",
      status: 403,
    });
    await client.control.release();
    await settleAll();
    for (const runId of [fromPlan.run_id, inline.run_id]) {
      const run = (
        await exchange({
          method: "GET",
          template: "/api/v1/runs/{run_id}",
          params: { run_id: runId },
          status: 200,
        })
      ).json as Run;
      expect(["canceled", "completed"]).toContain(run.status);
      const events = (await client.getEvents(runId)) as Array<Record<string, unknown>>;
      for (const event of events) {
        expectConforming(
          contract.checkSchema("StreamEvent", event),
          `${runId} event ${String(event.type)}#${String(event.seq)}`,
        );
      }
    }
    await exchange({
      method: "POST",
      template: "/api/v1/runs/{run_id}/cancel",
      params: { run_id: inline.run_id },
      status: 409,
    });
  });

  it("answers the declared errors when a run cannot start", async () => {
    await exchange({
      method: "POST",
      template: "/api/v1/runs",
      body: { plan_id: STAGE_TWO_IDS.plans.smartLog },
      status: 400,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/runs",
      body: { plan_id: MISSING_ID },
      headers: key(),
      status: 404,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/runs",
      body: { plan_id: STAGE_TWO_IDS.plans.smartLog },
      headers: key(),
      as: "viewer",
      status: 403,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/runs",
      body: { plan_id: STAGE_TWO_IDS.plans.smartLog },
      as: "anonymous",
      headers: key(),
      status: 401,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/runs",
      body: {},
      headers: key(),
      status: 422,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/runs",
      body: { plan_id: STAGE_TWO_IDS.plans.smartLog },
      headers: { "Idempotency-Key": "reused-key-0001" },
      status: 202,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/runs",
      body: { plan_id: STAGE_TWO_IDS.plans.apiSweep },
      headers: { "Idempotency-Key": "reused-key-0001" },
      status: 409,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/runs",
      body: { plan_id: "not-a-uuid" },
      invalidBody: "format",
      headers: key(),
      status: 422,
    });
    const invalidBodies: unknown[] = [
      { plan_id: STAGE_TWO_IDS.plans.smartLog, max_concurrency: 0 },
      { plan_id: STAGE_TWO_IDS.plans.smartLog, reset_seed: "yes" },
      { plan: { target_id: GRACIE_ID } },
    ];
    for (const body of invalidBodies) {
      await exchange({
        method: "POST",
        template: "/api/v1/runs",
        body,
        invalidBody: true,
        headers: key(),
        status: 422,
      });
    }
  });
});

describe("Stage 2: artifacts, feed and socket", () => {
  it("serves artifact bytes, ranges and the declared errors", async () => {
    const step = (
      await exchange({
        method: "GET",
        template: "/api/v1/steps/{step_id}",
        params: { step_id: seededStep("browserClick") },
        status: 200,
      })
    ).json as Step;
    expect(step.artifacts.length).toBeGreaterThanOrEqual(3);
    const declared = new Set(
      Object.keys(
        contract.operation("GET", "/api/v1/artifacts/{token}").responses["200"]?.content ?? {},
      ),
    );
    for (const artifact of step.artifacts) {
      expect(artifact.url.startsWith("/api/v1/artifacts/")).toBe(true);
      const response = await fetch(new URL(artifact.url, running.baseUrl));
      expect(response.status).toBe(200);
      expect(declared.has(response.headers.get("content-type") ?? "")).toBe(true);
      expect((await response.arrayBuffer()).byteLength).toBe(artifact.size_bytes);
      const partial = await fetch(new URL(artifact.url, running.baseUrl), {
        headers: { Range: "bytes=0-9" },
      });
      expect(partial.status).toBe(206);
      expect(partial.headers.get("content-range")).toBe(`bytes 0-9/${artifact.size_bytes}`);
      expect(declared.has(partial.headers.get("content-type") ?? "")).toBe(true);
      const beyond = await fetch(new URL(artifact.url, running.baseUrl), {
        headers: { Range: `bytes=${artifact.size_bytes + 10}-` },
      });
      expect(beyond.status).toBe(416);
      expectConforming(
        contract.checkResponse("GET", "/api/v1/artifacts/{token}", 416, await beyond.json()),
        "416 response",
      );
    }
    const first = step.artifacts[0];
    const token = first?.url.slice("/api/v1/artifacts/".length) ?? "";
    await exchange({
      method: "GET",
      template: "/api/v1/artifacts/{token}",
      params: { token: `${token}tampered` },
      as: "anonymous",
      status: 403,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/artifacts/{token}",
      params: { token: "garbage" },
      as: "anonymous",
      status: 403,
    });
  });

  it("streams run events on the feed in the StreamEvent shape", async () => {
    const feed = await client.openFeed(`target_id=${GRACIE_ID}&kind=suite`);
    expect(feed.status).toBe(200);
    expect(feed.contentType).toContain("text/event-stream");
    expect(
      Object.keys(contract.operation("GET", "/api/v1/feeds/runs").responses["200"]?.content ?? {}),
    ).toContain("text/event-stream");
    await feed.waitForType("stream.hello");
    const handle = await client.startInlineRun({
      feature_ids: ["smart_log.read.open_maintenance"],
    });
    await client.control.settle();
    await feed.waitForType("run.finished");
    expect(feed.messages.length).toBeGreaterThan(5);
    for (const message of feed.messages) {
      expectConforming(
        contract.checkSchema("StreamEvent", message.envelope),
        `feed ${message.envelope.type}`,
      );
    }
    expect(feed.types).toEqual(expect.arrayContaining(["run.created", "run.finished"]));
    expect(handle.run_id).toBeTruthy();
    feed.close();
    await exchange({
      method: "GET",
      template: "/api/v1/feeds/runs",
      as: "anonymous",
      status: 401,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/feeds/runs",
      query: "bogus=1",
      status: 422,
    });
  });

  it("sends only StreamEvent frames, tile frames included, on the run socket", async () => {
    await client.control.clock({ speed: 6 });
    await client.control.hold("first_step");
    const handle = await client.startInlineRun({
      feature_ids: ["guest_requests.flow.request_and_track"],
      roles: ["guest"],
      interface_mode: "browser_only",
    });
    const socket = await client.openRunSocket(handle.run_id);
    await socket.waitForType("stream.replay_end");
    await client.control.release();
    await socket.waitForType("tile.frame", 8000);
    await socket.waitForType("run.finished", 20000);
    expect(socket.types).toEqual(expect.arrayContaining(["stream.hello", "tile.frame"]));
    for (const frame of socket.frames) {
      expectConforming(contract.checkSchema("StreamEvent", frame), `socket ${frame.type}`);
    }
    socket.close();
  });
});

describe("Stage 3: oracle", () => {
  it("lists and reads every template and result", async () => {
    const list = (
      await exchange({
        method: "GET",
        template: "/api/v1/oracle-templates",
        query: `target_id=${GRACIE_ID}&limit=50&include_total=true`,
        status: 200,
      })
    ).json as OracleTemplatePage;
    expect(list.items.length).toBe(Object.keys(ORACLE_TEMPLATE_IDS).length);
    for (const query of [
      "feature_id=smart_log.read.open_maintenance",
      "feature_id=smart_log.read.open_maintenance&feature_id=smart_log.read.issue_detail",
      "approval=approved&approval=unreviewed&sort=name",
      `bundle_id=${list.items[0]?.bundle_id}`,
    ]) {
      await exchange({ method: "GET", template: "/api/v1/oracle-templates", query, status: 200 });
    }
    for (const id of Object.values(ORACLE_TEMPLATE_IDS)) {
      await exchange({
        method: "GET",
        template: "/api/v1/oracle-templates/{oracle_template_id}",
        params: { oracle_template_id: id },
        status: 200,
      });
      await exchange({
        method: "GET",
        template: "/api/v1/oracle-templates/{oracle_template_id}/results",
        params: { oracle_template_id: id },
        query: "limit=3&include_total=true",
        status: 200,
      });
    }
    for (const id of Object.values(ORACLE_RESULT_IDS)) {
      await exchange({
        method: "GET",
        template: "/api/v1/oracle-results/{oracle_result_id}",
        params: { oracle_result_id: id },
        status: 200,
      });
    }
  });

  it("runs a template, polls its result and approves it", async () => {
    const params = { tenant_id: "gracie-demo", as_of: "2026-10-01", role: "front_desk" };
    const started = (
      await exchange({
        method: "POST",
        template: "/api/v1/oracle-templates/{oracle_template_id}/runs",
        params: { oracle_template_id: ORACLE_TEMPLATE_IDS.openMaintenance },
        body: { params },
        headers: key(),
        as: "member",
        status: 202,
      })
    ).json as { id: string; status: string };
    expect(started.status).toBe("pending");
    await exchange({
      method: "GET",
      template: "/api/v1/oracle-results/{oracle_result_id}",
      params: { oracle_result_id: started.id },
      status: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
    const settled = (
      await exchange({
        method: "GET",
        template: "/api/v1/oracle-results/{oracle_result_id}",
        params: { oracle_result_id: started.id },
        status: 200,
      })
    ).json as { status: string };
    expect(settled.status).toBe("ok");
    await exchange({
      method: "PUT",
      template: "/api/v1/oracle-templates/{oracle_template_id}/approval",
      params: { oracle_template_id: ORACLE_TEMPLATE_IDS.openMaintenance },
      body: { approved: true, oracle_result_id: started.id },
      as: "member",
      status: 200,
    });
    await exchange({
      method: "PUT",
      template: "/api/v1/oracle-templates/{oracle_template_id}/approval",
      params: { oracle_template_id: ORACLE_TEMPLATE_IDS.openMaintenance },
      body: { approved: false, oracle_result_id: started.id },
      as: "member",
      status: 200,
    });
    await client.control.faults({ oracle_error: true });
    const failing = (
      await exchange({
        method: "POST",
        template: "/api/v1/oracle-templates/{oracle_template_id}/runs",
        params: { oracle_template_id: ORACLE_TEMPLATE_IDS.openMaintenance },
        body: { params },
        headers: key(),
        status: 202,
      })
    ).json as { id: string };
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
    const errored = (
      await exchange({
        method: "GET",
        template: "/api/v1/oracle-results/{oracle_result_id}",
        params: { oracle_result_id: failing.id },
        status: 200,
      })
    ).json as { status: string; error: string | null };
    expect(errored.status).toBe("error");
    expect(errored.error).not.toBeNull();
  });

  it("answers the declared errors", async () => {
    const template = { oracle_template_id: ORACLE_TEMPLATE_IDS.openMaintenance };
    const params = { tenant_id: "gracie-demo", as_of: "2026-10-01", role: "front_desk" };
    await exchange({
      method: "GET",
      template: "/api/v1/oracle-templates/{oracle_template_id}",
      params: { oracle_template_id: MISSING_ID },
      status: 404,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/oracle-results/{oracle_result_id}",
      params: { oracle_result_id: MISSING_ID },
      status: 404,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/oracle-templates",
      query: "approval=maybe",
      status: 422,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/oracle-templates/{oracle_template_id}/runs",
      params: template,
      body: { params },
      status: 400,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/oracle-templates/{oracle_template_id}/runs",
      params: template,
      body: { params },
      headers: key(),
      as: "viewer",
      status: 403,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/oracle-templates/{oracle_template_id}/runs",
      params: template,
      body: { params: { tenant_id: "gracie-demo" } },
      headers: key(),
      status: 422,
    });
    for (const body of [{}, { params: "x" }, { params: [] }]) {
      await exchange({
        method: "POST",
        template: "/api/v1/oracle-templates/{oracle_template_id}/runs",
        params: template,
        body,
        invalidBody: true,
        headers: key(),
        status: 422,
      });
    }
    await exchange({
      method: "PUT",
      template: "/api/v1/oracle-templates/{oracle_template_id}/approval",
      params: template,
      body: { approved: true, oracle_result_id: "x" },
      invalidBody: "format",
      as: "member",
      status: 422,
    });
    for (const body of [
      {},
      { approved: "yes", oracle_result_id: ORACLE_RESULT_IDS.openMaintenanceOk },
    ]) {
      await exchange({
        method: "PUT",
        template: "/api/v1/oracle-templates/{oracle_template_id}/approval",
        params: template,
        body,
        invalidBody: true,
        as: "member",
        status: 422,
      });
    }
    const unverifiedRun = (
      await exchange({
        method: "POST",
        template: "/api/v1/oracle-templates/{oracle_template_id}/runs",
        params: { oracle_template_id: ORACLE_TEMPLATE_IDS.rawSqlProbe },
        body: { params: { tenant_id: "gracie-demo" } },
        headers: key(),
        status: 202,
      })
    ).json as { id: string };
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
    await exchange({
      method: "PUT",
      template: "/api/v1/oracle-templates/{oracle_template_id}/approval",
      params: { oracle_template_id: ORACLE_TEMPLATE_IDS.rawSqlProbe },
      body: { approved: true, oracle_result_id: unverifiedRun.id },
      as: "member",
      status: 409,
    });
    await exchange({
      method: "PUT",
      template: "/api/v1/oracle-templates/{oracle_template_id}/approval",
      params: template,
      body: { approved: true, oracle_result_id: MISSING_ID },
      as: "member",
      status: 422,
    });
    await exchange({
      method: "PUT",
      template: "/api/v1/oracle-templates/{oracle_template_id}/approval",
      params: { oracle_template_id: MISSING_ID },
      body: { approved: true, oracle_result_id: ORACLE_RESULT_IDS.openMaintenanceOk },
      as: "member",
      status: 404,
    });
  });
});

describe("Stage 4: probes and settings", () => {
  it("lists the probe bank", async () => {
    await exchange({
      method: "GET",
      template: "/api/v1/probes",
      query: "limit=5&include_total=true",
      as: "viewer",
      status: 200,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/probes",
      query: "pack=generic&pack=llm_app&q=tone&sort=id",
      status: 200,
    });
    await exchange({ method: "GET", template: "/api/v1/probes", query: "pack=other", status: 422 });
    await exchange({
      method: "GET",
      template: "/api/v1/probes",
      as: "anonymous",
      status: 401,
    });
  });

  it("reads, patches, tests and sets secrets of the settings", async () => {
    await exchange({ method: "GET", template: "/api/v1/settings", as: "viewer", status: 200 });
    const patches: unknown[] = [
      {
        models: { judge: { effort: "high", max_usd: 0.1, model: "judge-1", timeout_seconds: 90 } },
      },
      { thresholds: { probe_confidence: 0.8, judge_escalate_below: 0.5, label_audit_rate: 0.2 } },
      { endpoints: { jev_url: "https://jev.example.test", laya_url: "http://localhost:9000" } },
      { budgets: { default_max_usd: 7, default_max_minutes: 20, max_concurrency: 3 } },
      { endpoints: { jev_url: null }, thresholds: { probe_confidence: null } },
      { models: { judge: { effort: null } } },
      {},
    ];
    for (const body of patches) {
      await exchange({
        method: "PATCH",
        template: "/api/v1/settings",
        body,
        status: 200,
      });
    }
    const invalid: unknown[] = [
      { thresholds: { probe_confidence: 1.5 } },
      { thresholds: { label_audit_rate: -0.1 } },
      { budgets: { default_max_usd: 0 } },
      { budgets: { max_concurrency: 0 } },
      { models: { judge: { effort: "extreme" } } },
      { models: { judge: { max_usd: -1 } } },
      { models: { judge: { model: "" } } },
      { endpoints: { jev_url: "" } },
      { budgets: "lots" },
    ];
    for (const body of invalid) {
      await exchange({
        method: "PATCH",
        template: "/api/v1/settings",
        body,
        invalidBody: true,
        status: 422,
      });
    }
    await exchange({
      method: "PATCH",
      template: "/api/v1/settings",
      body: { budgets: { max_concurrency: 2 } },
      as: "member",
      status: 403,
    });
    await exchange({ method: "GET", template: "/api/v1/settings", as: "anonymous", status: 401 });
    for (const name of [
      "openai_api_key",
      "anthropic_api_key",
      "jev_api_key",
      "slack_webhook_url",
      "smtp_password",
    ]) {
      await exchange({
        method: "PUT",
        template: "/api/v1/settings/secrets/{name}",
        params: { name },
        body: {
          value:
            name === "slack_webhook_url"
              ? "https://hooks.example.test/services/dev-only"
              : "dev-only-placeholder-value",
        },
        status: 200,
      });
      await exchange({
        method: "DELETE",
        template: "/api/v1/settings/secrets/{name}",
        params: { name },
        status: 204,
      });
    }
    for (const body of [{}, { value: "" }, { value: 5 }]) {
      await exchange({
        method: "PUT",
        template: "/api/v1/settings/secrets/{name}",
        params: { name: "openai_api_key" },
        body,
        invalidBody: true,
        status: 422,
      });
    }
    await exchange({
      method: "PUT",
      template: "/api/v1/settings/secrets/{name}",
      params: { name: "not_a_secret" },
      body: { value: "x" },
      status: 422,
    });
    await exchange({
      method: "DELETE",
      template: "/api/v1/settings/secrets/{name}",
      params: { name: "not_a_secret" },
      status: 422,
    });
    await exchange({
      method: "PUT",
      template: "/api/v1/settings/secrets/{name}",
      params: { name: "openai_api_key" },
      body: { value: "x" },
      as: "member",
      status: 403,
    });
    for (const service of ["laya", "openai", "anthropic", "jev", "temporal", "slack", "smtp"]) {
      await exchange({
        method: "POST",
        template: "/api/v1/settings/test/{service}",
        params: { service },
        status: 200,
      });
    }
    await client.control.faults({ service_test_fail: true });
    await exchange({
      method: "POST",
      template: "/api/v1/settings/test/{service}",
      params: { service: "laya" },
      status: 200,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/settings/test/{service}",
      params: { service: "not_a_service" },
      status: 422,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/settings/test/{service}",
      params: { service: "laya" },
      as: "member",
      status: 403,
    });
  });

  it("reads settings in every seeded state", async () => {
    for (const settings of ["default", "overridden", "unconfigured"]) {
      await fetch(`${running.baseUrl}/__mock/stage4/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      await exchange({ method: "GET", template: "/api/v1/settings", status: 200 });
    }
  });
});

describe("Stage 4: labels", () => {
  it("reads the queue and stats, creates, replaces and deletes a label", async () => {
    const queue = (
      await exchange({
        method: "GET",
        template: "/api/v1/labels/queue",
        query: "limit=60&include_total=true",
        as: "viewer",
        status: 200,
      })
    ).json as LabelTaskPage;
    expect(queue.items.length).toBeGreaterThan(20);
    for (const query of [
      "subject_type=step&subject_type=judge_result",
      "reason=uncertain&reason=audit",
      `target_id=${STAGE_ONE_IDS.billing}`,
      `target_id=${GRACIE_ID}&limit=2&sort=created_at`,
    ]) {
      await exchange({ method: "GET", template: "/api/v1/labels/queue", query, status: 200 });
    }
    await exchange({ method: "GET", template: "/api/v1/labels/stats", as: "viewer", status: 200 });
    const task = queue.items[0];
    if (task === undefined) {
      throw new Error("the label queue is empty");
    }
    const body = { subject_type: task.subject_type, subject_id: task.subject_id, value: "fail" };
    const created = (
      await exchange({
        method: "POST",
        template: "/api/v1/labels",
        body: { ...body, note: "Looks wrong" },
        headers: key(),
        as: "member",
        status: 201,
      })
    ).json as Label;
    await exchange({
      method: "POST",
      template: "/api/v1/labels",
      body: { ...body, value: "pass", note: null },
      headers: key(),
      as: "member",
      status: 200,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/labels",
      body: { ...body, value: "uncertain" },
      as: "member",
      status: 200,
    });
    for (const query of [
      "",
      `subject_id=${task.subject_id}`,
      "subject_type=step&source=human&limit=5&include_total=true",
      `labeled_by=${MISSING_ID}`,
    ]) {
      await exchange({ method: "GET", template: "/api/v1/labels", query, status: 200 });
    }
    await exchange({ method: "GET", template: "/api/v1/labels/stats", status: 200 });
    await exchange({
      method: "DELETE",
      template: "/api/v1/labels/{label_id}",
      params: { label_id: created.id },
      as: "member",
      status: 204,
    });
    await exchange({
      method: "DELETE",
      template: "/api/v1/labels/{label_id}",
      params: { label_id: created.id },
      as: "member",
      status: 404,
    });
  });

  it("answers the declared errors and rejects the bodies the schema rejects", async () => {
    const subject = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3bc001";
    await exchange({
      method: "POST",
      template: "/api/v1/labels",
      body: { subject_type: "step", subject_id: subject, value: "pass" },
      headers: key(),
      as: "viewer",
      status: 403,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/labels",
      body: { subject_type: "step", subject_id: subject, value: "pass" },
      headers: key(),
      as: "anonymous",
      status: 401,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/labels",
      body: { subject_type: "step", subject_id: "x", value: "pass" },
      invalidBody: "format",
      headers: key(),
      as: "member",
      status: 422,
    });
    const invalidBodies: unknown[] = [
      { subject_type: "nope", subject_id: subject, value: "pass" },
      { subject_type: "step", subject_id: subject, value: "great" },
      { subject_type: "step", subject_id: subject, value: "pass", note: "x".repeat(1001) },
      { subject_type: "step", subject_id: subject },
    ];
    for (const body of invalidBodies) {
      await exchange({
        method: "POST",
        template: "/api/v1/labels",
        body,
        invalidBody: true,
        headers: key(),
        as: "member",
        status: 422,
      });
    }
    await exchange({
      method: "DELETE",
      template: "/api/v1/labels/{label_id}",
      params: { label_id: "nope" },
      as: "member",
      status: 422,
    });
    await exchange({
      method: "DELETE",
      template: "/api/v1/labels/{label_id}",
      params: { label_id: MISSING_ID },
      as: "viewer",
      status: 403,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/labels/queue",
      query: "reason=boredom",
      status: 422,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/labels",
      query: "source=robot",
      status: 422,
    });
    await exchange({
      method: "GET",
      template: "/api/v1/labels/stats",
      as: "anonymous",
      status: 401,
    });
  });
});

describe("request boundaries of the generated schemas", () => {
  it("accepts the edge values the request schemas allow", async () => {
    const valid = client.planBody();
    await exchange({
      method: "POST",
      template: "/api/v1/plans/preview",
      body: {
        ...valid,
        name: "n".repeat(120),
        selection: {
          ...valid.selection,
          k: 10,
          budget: { max_usd: 0, max_minutes: 1 },
        },
      },
      status: 200,
    });
    await exchange({
      method: "POST",
      template: "/api/v1/runs",
      body: { plan_id: STAGE_TWO_IDS.plans.smartLog, max_concurrency: 1 },
      headers: key(),
      status: 202,
    });
    const subject = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3bc001";
    await exchange({
      method: "POST",
      template: "/api/v1/labels",
      body: { subject_type: "step", subject_id: subject, value: "pass", note: "n".repeat(1000) },
      as: "member",
      status: 201,
    });
    await exchange({
      method: "PUT",
      template: "/api/v1/settings/secrets/{name}",
      params: { name: "openai_api_key" },
      body: { value: "s".repeat(4096) },
      status: 200,
    });
    const edgePatches: unknown[] = [
      { models: { judge: { max_usd: 0, timeout_seconds: 1 } } },
      { thresholds: { probe_confidence: 0, judge_escalate_below: 1, label_audit_rate: 0 } },
      { budgets: { default_max_usd: 0.01, default_max_minutes: 1, max_concurrency: 1 } },
      { endpoints: { jev_url: `https://jev.example.test/${"a".repeat(2000)}` } },
    ];
    for (const body of edgePatches) {
      await exchange({ method: "PATCH", template: "/api/v1/settings", body, status: 200 });
    }
  });

  it("rejects the values just beyond the edge", async () => {
    const valid = client.planBody();
    const planBodies: unknown[] = [
      { ...valid, name: "n".repeat(121) },
      { ...valid, selection: { ...valid.selection, budget: { max_usd: 1, max_minutes: 0 } } },
      { ...valid, selection: { ...valid.selection, k: 0 } },
    ];
    for (const body of planBodies) {
      await exchange({
        method: "POST",
        template: "/api/v1/plans/preview",
        body,
        invalidBody: true,
        status: 422,
      });
    }
    await exchange({
      method: "PUT",
      template: "/api/v1/settings/secrets/{name}",
      params: { name: "openai_api_key" },
      body: { value: "s".repeat(4097) },
      invalidBody: true,
      status: 422,
    });
    const patches: unknown[] = [
      { models: { judge: { timeout_seconds: 0 } } },
      { models: { judge: { max_usd: -0.01 } } },
      { models: { judge: { unknown: 1 } } },
      { models: { bogus: { effort: "low" } } },
      { thresholds: { probe_confidence: 1.01 } },
      { thresholds: { judge_escalate_below: -0.01 } },
      { budgets: { default_max_minutes: 0 } },
      { budgets: { default_max_usd: 0 } },
      { endpoints: { jev_url: `https://jev.example.test/${"a".repeat(2100)}` } },
      { unknown: {} },
    ];
    for (const body of patches) {
      await exchange({
        method: "PATCH",
        template: "/api/v1/settings",
        body,
        invalidBody: true,
        status: 422,
      });
    }
  });
});

describe("faulted runs", () => {
  it("emits conforming events for a budget breach and flaky verdicts", async () => {
    await client.control.faults({ budget_exhausted: 1, verdict_flaky: true });
    const handle = (
      await exchange({
        method: "POST",
        template: "/api/v1/runs",
        body: { plan_id: STAGE_TWO_IDS.plans.apiSweep },
        headers: key(),
        status: 202,
      })
    ).json as { run_id: string };
    await settleAll();
    const run = (
      await exchange({
        method: "GET",
        template: "/api/v1/runs/{run_id}",
        params: { run_id: handle.run_id },
        status: 200,
      })
    ).json as Run;
    expect(run.status).toBe("budget_exceeded");
    const events = (await client.getEvents(handle.run_id)) as Array<Record<string, unknown>>;
    expect(events.some((event) => event.type === "budget.exhausted")).toBe(true);
    for (const event of events) {
      expectConforming(
        contract.checkSchema("StreamEvent", event),
        `${String(event.type)}#${String(event.seq)}`,
      );
    }
    const scenarios = (
      await exchange({
        method: "GET",
        template: "/api/v1/runs/{run_id}/scenarios",
        params: { run_id: handle.run_id },
        query: "limit=200",
        status: 200,
      })
    ).json as RunScenarioPage;
    for (const scenario of scenarios.items) {
      await exchange({
        method: "GET",
        template: "/api/v1/run-scenarios/{run_scenario_id}",
        params: { run_scenario_id: scenario.id },
        status: 200,
      });
    }
  });

  it("serves an expired artifact url once under the artifact_expired fault", async () => {
    await client.control.faults({ artifact_expired: true });
    await exchange({
      method: "GET",
      template: "/api/v1/steps/{step_id}",
      params: { step_id: seededStep("browserClick") },
      status: 200,
    });
  });
});

describe("coverage of the OpenAPI document", () => {
  it("exercises every Stage 2 to 4 operation or lists it as skipped with a reason", () => {
    const document = contract.operations();
    const staged = document.filter(({ path }) =>
      STAGE_PATH_PATTERNS.some((pattern) => pattern.test(path)),
    );
    expect(staged.length).toBeGreaterThan(40);
    const labels = staged.map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    const missing = labels.filter((label) => !covered.has(label) && !(label in SKIPPED_OPERATIONS));
    expect(missing, "operations neither exercised nor skipped").toEqual([]);
    const staleSkips = Object.keys(SKIPPED_OPERATIONS).filter(
      (label) => !labels.includes(label) || covered.has(label),
    );
    expect(staleSkips, "skip entries that no longer apply").toEqual([]);
    const unknownCovered = [...covered].filter((label) => !labels.includes(label));
    expect(unknownCovered).toEqual([]);
  });

  it.each(Object.keys(SKIPPED_OPERATIONS))(
    "still has no mock handler for the skipped operation %s",
    async (label) => {
      const [method, template] = label.split(" ") as [Method, string];
      const path = fill(template, {
        target_id: GRACIE_ID,
        seed_id: MISSING_ID,
      });
      const headers = {
        ...(await client.headers("admin")),
        ...(method === "POST" ? { "Content-Type": "application/json", ...key() } : {}),
      };
      const response = await fetch(`${running.baseUrl}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify({}) : undefined,
      });
      expect([404, 405, 501], `${label} now answers ${response.status}; cover it above`).toContain(
        response.status,
      );
      const body = (await response.json()) as { error?: { code?: string } };
      expect(["not_found", "method_not_allowed", "not_implemented"]).toContain(body.error?.code);
    },
  );
});
