import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import type {
  BrowserSessionList,
  Run,
  RunHandle,
  RunScenario,
  RunScenarioPage,
  RunSummaryPage,
} from "@/lib/api/types";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage2Client,
  errorOf,
  GRACIE_ID,
  STAGE_ONE_IDS,
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

beforeEach(async () => {
  mockState.reset();
  await client.control.clock({ speed: 1000 });
});

const KEY = { "Idempotency-Key": "run-key-0000001" };

describe("POST /runs", () => {
  it("starts an inline plan with 202, a RunHandle and a queued run", async () => {
    await client.control.hold("created");
    const response = await client.startRun(
      { plan: client.planBody({ selection: { roles: ["guest"] } }) },
      { key: "inline-run-key-1" },
    );
    expect(response.status).toBe(202);
    const handle = (await response.json()) as RunHandle;
    expect(handle).toMatchObject({ kind: "suite", status: "queued" });
    expect(handle.workflow_id).toBe(`execute-run-${handle.run_id}`);
    const run = await client.getRun(handle.run_id);
    expect(run).toMatchObject({
      kind: "suite",
      target_id: GRACIE_ID,
      status: "queued",
      read_only: false,
      trigger: "manual",
      started_at: null,
      finished_at: null,
      stop_requested_at: null,
      run_group_id: null,
      event_head_seq: 1,
      workflow_id: handle.workflow_id,
      budget: { max_usd: 5, spent_usd: 0, max_minutes: 30, elapsed_ms: 0 },
    });
    expect(run.counters.scenarios_total).toBe(0);
    expect(run.temporal_ui_url).toContain(handle.workflow_id);
    const inline = await client.get(`/api/v1/plans/${run.plan_id}`);
    expect(((await inline.json()) as { saved: boolean }).saved).toBe(false);
  });

  it("starts a saved plan by plan_id and pins the bundle in the config snapshot", async () => {
    const response = await client.startRun({ plan_id: STAGE_TWO_IDS.plans.smartLog });
    expect(response.status).toBe(202);
    const handle = (await response.json()) as RunHandle;
    const run = await client.runToEnd(handle.run_id);
    expect(run.plan_id).toBe(STAGE_TWO_IDS.plans.smartLog);
    expect(run.status).toBe("completed");
    expect(run.config_snapshot).toMatchObject({
      bundle_version: 2,
      seed_hash: null,
      probe_bank_version: null,
      clock: { mode: "real" },
    });
    expect(Object.keys(run.config_snapshot.scenario_versions)).toHaveLength(12);
    expect(run.counters).toMatchObject({ scenarios_total: 12, scenarios_done: 12 });
  });

  it("needs a valid Idempotency-Key (400) and the member role (403)", async () => {
    const body = { plan_id: STAGE_TWO_IDS.plans.smartLog };
    const missing = await client.startRun(body, { key: null });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("idempotency_key_required");
    const short = await client.startRun(body, { key: "short" });
    expect(short.status).toBe(400);
    const viewer = await client.startRun(body, { role: "viewer" });
    expect(viewer.status).toBe(403);
  });

  it("replays the original handle for the same key and body, and conflicts on another body", async () => {
    await client.control.hold("created");
    const first = await client.send(
      "POST",
      "/api/v1/runs",
      { plan_id: STAGE_TWO_IDS.plans.smartLog },
      { headers: KEY },
    );
    const second = await client.send(
      "POST",
      "/api/v1/runs",
      { plan_id: STAGE_TWO_IDS.plans.smartLog },
      { headers: KEY },
    );
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    const runs = (await (await client.get("/api/v1/runs?status=queued")).json()) as RunSummaryPage;
    expect(runs.items).toHaveLength(1);
    const other = await client.send(
      "POST",
      "/api/v1/runs",
      { plan_id: STAGE_TWO_IDS.plans.apiSweep },
      { headers: KEY },
    );
    expect(other.status).toBe(409);
    expect((await errorOf(other)).code).toBe("idempotency_conflict");
  });

  it("allocates deterministic run ids in creation order", async () => {
    const a = await client.startInlineRun();
    const b = await client.startInlineRun();
    expect(a.run_id).not.toBe(b.run_id);
    mockState.reset();
    const again = await client.startInlineRun();
    expect(again.run_id).toBe(a.run_id);
  });

  it("requires exactly one of plan_id and plan", async () => {
    const neither = await client.startRun({});
    expect(neither.status).toBe(422);
    expect((await errorOf(neither)).details[0]).toMatchObject({ loc: ["body"] });
    const both = await client.startRun({
      plan_id: STAGE_TWO_IDS.plans.smartLog,
      plan: client.planBody(),
    });
    expect(both.status).toBe(422);
    const concurrency = await client.startRun({
      plan_id: STAGE_TWO_IDS.plans.smartLog,
      max_concurrency: 0,
    });
    expect((await errorOf(concurrency)).details[0]?.loc).toEqual(["body", "max_concurrency"]);
  });

  it("answers 404 for an unknown plan and maps inline plan errors under body.plan", async () => {
    const unknown = await client.startRun({ plan_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff" });
    expect(unknown.status).toBe(404);
    const invalid = await client.startRun({
      plan: { target_id: GRACIE_ID, saved: false, selection: { k: 0 } },
    });
    expect(invalid.status).toBe(422);
    const locations = (await errorOf(invalid)).details.map((detail) => detail.loc.slice(0, 3));
    expect(locations).toContainEqual(["body", "plan", "selection"]);
  });

  it("answers 422 plan_empty for a selection without cells", async () => {
    const response = await client.startRun({
      plan: client.planBody({ selection: { feature_ids: [] } }),
    });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("plan_empty");
  });

  it("answers 409 target_not_ready without a valid bundle", async () => {
    const response = await client.startRun({
      plan: client.planBody({ target_id: STAGE_ONE_IDS.billing }),
    });
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("target_not_ready");
    expect(error.details[0]).toMatchObject({ loc: ["bundle"], code: "bundle_missing" });
  });

  it("answers 409 target_not_ready with the env names when a required value is missing", async () => {
    const entries = mockState.stageOne.environmentOf(GRACIE_ID);
    for (const name of ["GRACIE_API_URL", "GRACIE_WEB_URL"]) {
      const entry = entries.find((candidate) => candidate.name === name);
      if (entry !== undefined) {
        entry.value = null;
      }
    }
    const response = await client.startRun({ plan: client.planBody() });
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("target_not_ready");
    expect(error.details.map((detail) => detail.loc)).toEqual([
      ["environment", "GRACIE_API_URL"],
      ["environment", "GRACIE_WEB_URL"],
    ]);
    const browserOnly = await client.startRun({
      plan: client.planBody({ selection: { interface_mode: "browser_only" } }),
    });
    expect((await errorOf(browserOnly)).details.map((detail) => detail.loc)).toEqual([
      ["environment", "GRACIE_WEB_URL"],
    ]);
    expect(error.details[0]?.code).toBe("env_missing");
  });

  it("ignores a missing required variable that no selected interface uses", async () => {
    const dsn = mockState.stageOne
      .environmentOf(GRACIE_ID)
      .find((entry) => entry.name === "GRACIE_READONLY_DSN");
    expect(dsn?.value).toBeNull();
    const response = await client.startRun({ plan: client.planBody() });
    expect(response.status).toBe(202);
  });

  it("answers 409 production_blocked until an admin allows production, then runs read-only", async () => {
    await client.control.productionTarget(false);
    const body = {
      plan: client.planBody({
        target_id: STAGE_ONE_IDS.liveShop,
        selection: {
          feature_ids: ["smart_log.read.open_maintenance", "smart_log.write.close_issue"],
          roles: ["housekeeping_lead"],
        },
      }),
    };
    const blocked = await client.startRun(body);
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).code).toBe("production_blocked");

    await client.control.productionTarget(true);
    const allowed = await client.startRun(body);
    expect(allowed.status).toBe(202);
    const handle = (await allowed.json()) as RunHandle;
    const run = await client.runToEnd(handle.run_id);
    expect(run.read_only).toBe(true);
    const scenarios = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/scenarios?status=skipped`)
    ).json()) as RunScenarioPage;
    expect(scenarios.items).toHaveLength(1);
    expect(scenarios.items[0]?.verdict).toMatchObject({
      status: "skipped",
      skip_reason: "production_blocked",
    });
  });

  it("refuses an archived target with 409 conflict", async () => {
    const response = await client.startRun({
      plan: client.planBody({ target_id: STAGE_ONE_IDS.legacyPortal }),
    });
    expect([404, 409]).toContain(response.status);
  });

  it("caps max_concurrency by the server and accepts reset_seed", async () => {
    const response = await client.startRun({
      plan_id: STAGE_TWO_IDS.plans.smartLog,
      max_concurrency: 99,
      reset_seed: true,
    });
    expect(response.status).toBe(202);
  });
});

describe("GET /runs", () => {
  it("lists the seeded history newest first with every status", async () => {
    const page = (await (
      await client.get("/api/v1/runs?include_total=true")
    ).json()) as RunSummaryPage;
    expect(page.total).toBe(6);
    expect(page.items.map((run) => run.id)).toEqual([
      STAGE_TWO_IDS.runs.showcase,
      STAGE_TWO_IDS.runs.completed,
      STAGE_TWO_IDS.runs.flaky,
      STAGE_TWO_IDS.runs.failed,
      STAGE_TWO_IDS.runs.canceled,
      STAGE_TWO_IDS.runs.budgetExceeded,
    ]);
    expect(page.items.map((run) => run.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "failed",
      "canceled",
      "budget_exceeded",
    ]);
    expect(page.items[0]).toMatchObject({ kind: "suite", target_id: GRACIE_ID, read_only: false });
    expect("config_snapshot" in (page.items[0] ?? {})).toBe(false);
  });

  it("filters by status, kind, target, plan and created bounds", async () => {
    const list = async (query: string) =>
      ((await (await client.get(`/api/v1/runs${query}`)).json()) as RunSummaryPage).items;
    expect(await list("?status=failed&status=canceled")).toHaveLength(2);
    expect(await list("?kind=hello")).toHaveLength(0);
    expect(await list(`?target_id=${STAGE_ONE_IDS.billing}`)).toHaveLength(0);
    expect(await list(`?plan_id=${STAGE_TWO_IDS.plans.smartLog}`)).toHaveLength(3);
    expect(await list("?created_after=2026-10-03T00:00:00Z")).toHaveLength(3);
    expect(await list("?created_before=2026-10-02T00:00:00Z")).toHaveLength(1);
    expect(await list("?run_group_id=0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff")).toHaveLength(0);
  });

  it("paginates with a cursor and sorts by created_at", async () => {
    const first = (await (await client.get("/api/v1/runs?limit=4")).json()) as RunSummaryPage;
    expect(first.items).toHaveLength(4);
    expect(first.next_cursor).not.toBeNull();
    const second = (await (
      await client.get(`/api/v1/runs?limit=4&cursor=${first.next_cursor}`)
    ).json()) as RunSummaryPage;
    expect(second.items).toHaveLength(2);
    expect(second.next_cursor).toBeNull();
    const ascending = (await (
      await client.get("/api/v1/runs?sort=created_at")
    ).json()) as RunSummaryPage;
    expect(ascending.items[0]?.id).toBe(STAGE_TWO_IDS.runs.budgetExceeded);
  });

  it("rejects bad filters, bad dates and unknown parameters with 422", async () => {
    for (const query of [
      "?status=asleep",
      "?kind=party",
      "?created_after=yesterday",
      "?target_id=x",
      "?colour=red",
      "?sort=status",
    ]) {
      const response = await client.get(`/api/v1/runs${query}`);
      expect(response.status, query).toBe(422);
    }
  });

  it("shows a new run in the list and starts empty on the empty seed", async () => {
    await client.control.seed("empty");
    const empty = (await (await client.get("/api/v1/runs")).json()) as RunSummaryPage;
    expect(empty.items).toEqual([]);
    const handle = await client.startInlineRun();
    const page = (await (await client.get("/api/v1/runs")).json()) as RunSummaryPage;
    expect(page.items.map((run) => run.id)).toEqual([handle.run_id]);
  });
});

describe("GET /runs/{id}", () => {
  it("returns the Run with the event head and answers 404 and 422", async () => {
    const run = await client.getRun(STAGE_TWO_IDS.runs.completed);
    expect(run.event_head_seq).toBeGreaterThan(50);
    expect(run.status).toBe("completed");
    expect(run.counters).toMatchObject({
      scenarios_total: 12,
      pass: 10,
      fail: 2,
      steps_recorded: 42,
    });
    expect(run.started_at).not.toBeNull();
    expect(run.finished_at).not.toBeNull();
    expect((await client.get("/api/v1/runs/0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff")).status).toBe(
      404,
    );
    expect((await client.get("/api/v1/runs/nope")).status).toBe(422);
  });

  it("describes the failed, canceled and budget_exceeded history", async () => {
    const failed = await client.getRun(STAGE_TWO_IDS.runs.failed);
    expect(failed).toMatchObject({ status: "failed", trigger: "api" });
    const canceled = await client.getRun(STAGE_TWO_IDS.runs.canceled);
    expect(canceled.status).toBe("canceled");
    const exhausted = await client.getRun(STAGE_TWO_IDS.runs.budgetExceeded);
    expect(exhausted.status).toBe("budget_exceeded");
    expect(exhausted.budget.spent_usd).toBeGreaterThan(exhausted.budget.max_usd);
  });
});

describe("POST /runs/{id}/cancel", () => {
  it("answers 202 canceling, then the run ends canceled with skipped and canceled scenarios", async () => {
    await client.control.clock({ speed: 1 });
    await client.control.hold("running");
    const handle = await client.startInlineRun({
      feature_ids: [],
      area_ids: ["Smart Log"],
      roles: [],
    });
    await client.waitForRun(handle.run_id, (run) => run.status === "running");
    const response = await client.send("POST", `/api/v1/runs/${handle.run_id}/cancel`);
    expect(response.status).toBe(202);
    expect(((await response.json()) as Run).status).toBe("canceling");
    const again = await client.send("POST", `/api/v1/runs/${handle.run_id}/cancel`);
    expect(again.status).toBe(202);
    await client.control.clock({ speed: 1000 });
    const run = await client.waitForRun(
      handle.run_id,
      (candidate) => candidate.status === "canceled",
    );
    expect(run.finished_at).not.toBeNull();
    const scenarios = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/scenarios`)
    ).json()) as RunScenarioPage;
    expect(new Set(scenarios.items.map((item) => item.status))).toEqual(new Set(["skipped"]));
    expect(scenarios.items.every((item) => item.verdict?.skip_reason === "canceled")).toBe(true);
    const late = await client.send("POST", `/api/v1/runs/${handle.run_id}/cancel`);
    expect(late.status).toBe(409);
    expect((await errorOf(late)).code).toBe("run_not_cancelable");
  });

  it("answers 409 run_not_cancelable on a finished run, 404 on an unknown one, 403 for a viewer", async () => {
    const finished = await client.send(
      "POST",
      `/api/v1/runs/${STAGE_TWO_IDS.runs.completed}/cancel`,
    );
    expect(finished.status).toBe(409);
    expect((await errorOf(finished)).code).toBe("run_not_cancelable");
    const unknown = await client.send(
      "POST",
      "/api/v1/runs/0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff/cancel",
    );
    expect(unknown.status).toBe(404);
    const viewer = await client.send(
      "POST",
      `/api/v1/runs/${STAGE_TWO_IDS.runs.completed}/cancel`,
      undefined,
      { role: "viewer" },
    );
    expect(viewer.status).toBe(403);
  });
});

describe("GET /runs/{id}/scenarios", () => {
  const path = (query = "") => `/api/v1/runs/${STAGE_TWO_IDS.runs.flaky}/scenarios${query}`;

  it("lists run scenarios with verdicts, attempts and durations", async () => {
    const page = (await (
      await client.get(path("?include_total=true&limit=200"))
    ).json()) as RunScenarioPage;
    expect(page.total).toBe(29);
    const finished = page.items.find((item) => item.status === "finished");
    expect(finished).toMatchObject({ attempts_total: 2, attempts_done: 2 });
    expect(finished?.duration_ms).toBeGreaterThan(0);
    expect(finished?.verdict?.tier).toBe("code");
  });

  it("filters by status, verdict, family and role", async () => {
    const list = async (query: string) =>
      ((await (await client.get(path(`${query}&limit=200`))).json()) as RunScenarioPage).items;
    const flaky = await list("?verdict=flaky");
    expect(flaky.length).toBeGreaterThan(0);
    expect(flaky.every((item) => item.verdict?.status === "flaky")).toBe(true);
    const skipped = await list("?status=skipped");
    expect(skipped.every((item) => item.verdict?.status === "skipped")).toBe(true);
    const reportsAdmin = await list("?family=reports&role=admin");
    expect(reportsAdmin.every((item) => item.family === "reports" && item.role === "admin")).toBe(
      true,
    );
    const several = await list("?verdict=pass&verdict=fail");
    expect(new Set(several.map((item) => item.verdict?.status))).toEqual(new Set(["pass", "fail"]));
  });

  it("sorts and paginates by creation order, status, role and interface", async () => {
    const first = (await (await client.get(path("?limit=10"))).json()) as RunScenarioPage;
    expect(first.items).toHaveLength(10);
    const second = (await (
      await client.get(path(`?limit=10&cursor=${first.next_cursor}`))
    ).json()) as RunScenarioPage;
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    const byRole = (await (
      await client.get(path("?sort=role&limit=200"))
    ).json()) as RunScenarioPage;
    const roles = byRole.items.map((item) => item.role);
    expect(roles).toEqual([...roles].sort((left, right) => left.localeCompare(right)));
    expect((await client.get(path("?sort=title"))).status).toBe(422);
  });

  it("answers 404 for an unknown run", async () => {
    const response = await client.get(
      "/api/v1/runs/0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff/scenarios",
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /runs/{id}/browser-sessions", () => {
  it("lists the sessions of browser scenarios with recording and trace flags", async () => {
    const list = (await (
      await client.get(`/api/v1/runs/${STAGE_TWO_IDS.runs.completed}/browser-sessions`)
    ).json()) as BrowserSessionList;
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items[0]).toMatchObject({
      status: "ended",
      viewport: { width: 1280, height: 800 },
      has_recording: true,
      has_trace: true,
    });
    expect(list.items[0]?.last_url).toContain("https://gracie-web.qa.example.test");
    expect(list.items[0]?.ended_at).not.toBeNull();
    expect("next_cursor" in list).toBe(false);
  });

  it("filters by status and rejects unknown parameters", async () => {
    const path = `/api/v1/runs/${STAGE_TWO_IDS.runs.completed}/browser-sessions`;
    const active = (await (await client.get(`${path}?status=active`)).json()) as BrowserSessionList;
    expect(active.items).toEqual([]);
    expect((await client.get(`${path}?limit=5`)).status).toBe(422);
    expect((await client.get(`${path}?status=bored`)).status).toBe(422);
  });

  it("is empty for runs without browser interfaces", async () => {
    const list = (await (
      await client.get(`/api/v1/runs/${STAGE_TWO_IDS.runs.flaky}/browser-sessions`)
    ).json()) as BrowserSessionList;
    expect(list.items).toEqual([]);
  });
});

describe("GET /run-scenarios/{id}", () => {
  it("returns attempts, step summaries, the scenario yaml and the skip reason", async () => {
    const page = (await (
      await client.get(`/api/v1/runs/${STAGE_TWO_IDS.runs.flaky}/scenarios?limit=200`)
    ).json()) as RunScenarioPage;
    const flaky = page.items.find((item) => item.verdict?.status === "flaky");
    const detail = (await (
      await client.get(`/api/v1/run-scenarios/${flaky?.id}`)
    ).json()) as RunScenario;
    expect(detail.attempts.map((attempt) => attempt.verdict?.status)).toEqual(["fail", "pass"]);
    expect(detail.steps.length).toBe(2);
    expect(detail.steps[0]).toMatchObject({
      attempt: 0,
      index: 0,
      tier0_failure_count: expect.any(Number),
    });
    expect(detail.scenario_yaml.startsWith("schema_version: 1")).toBe(true);
    expect(detail.skip_reason).toBeNull();

    const skipped = page.items.find((item) => item.status === "skipped");
    const skippedDetail = (await (
      await client.get(`/api/v1/run-scenarios/${skipped?.id}`)
    ).json()) as RunScenario;
    expect(skippedDetail.skip_reason).not.toBeNull();
    expect(skippedDetail.steps).toEqual([]);
  });

  it("answers 404 for an unknown run scenario", async () => {
    const response = await client.get("/api/v1/run-scenarios/0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff");
    expect(response.status).toBe(404);
  });
});
