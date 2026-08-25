import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import type { CoverageCellPage, Plan, PlanPage, PlanPreview } from "@/lib/api/types";
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

beforeEach(() => {
  mockState.reset();
});

describe("POST /plans/preview", () => {
  it("expands features x roles x interfaces and echoes the server budget defaults", async () => {
    const preview = await client.preview(
      client.planBody({ selection: { roles: ["guest", "manager"] } }),
    );
    expect(preview).toEqual({
      cells_total: 4,
      scenarios_estimated: 4,
      skipped: [],
      warnings: [],
      effective_budget: { max_usd: 5, max_minutes: 30 },
      estimated_cost_usd: null,
    });
  });

  it("echoes selection.budget as effective_budget", async () => {
    const preview = await client.preview(
      client.planBody({ selection: { budget: { max_usd: 1.5, max_minutes: 12 } } }),
    );
    expect(preview.effective_budget).toEqual({ max_usd: 1.5, max_minutes: 12 });
  });

  it("treats empty roles and the all role as every role of the feature", async () => {
    const everyRole = await client.preview(client.planBody({ selection: { roles: [] } }));
    expect(everyRole.cells_total).toBe(10);
    const allKeyword = await client.preview(client.planBody({ selection: { roles: ["all"] } }));
    expect(allKeyword.cells_total).toBe(10);
  });

  it("honours interface_mode: api_only drops browser, browser_only keeps only browser", async () => {
    const both = await client.preview(client.planBody({ selection: { roles: [] } }));
    const apiOnly = await client.preview(
      client.planBody({ selection: { roles: [], interface_mode: "api_only" } }),
    );
    const browserOnly = await client.preview(
      client.planBody({ selection: { roles: [], interface_mode: "browser_only" } }),
    );
    expect([both.cells_total, apiOnly.cells_total, browserOnly.cells_total]).toEqual([10, 5, 5]);
  });

  it("expands areas and lists skip reasons per feature", async () => {
    const preview = await client.preview(
      client.planBody({
        selection: {
          feature_ids: [],
          area_ids: ["Guest Requests"],
          roles: ["guest"],
          interface_mode: "browser_only",
        },
      }),
    );
    expect(preview.cells_total).toBe(1);
    expect(preview.skipped).toEqual([
      {
        feature_id: "guest_requests.read.list_open",
        role: null,
        interface_id: null,
        reason: "role_unavailable",
      },
      {
        feature_id: "guest_requests.write.create_service_request",
        role: null,
        interface_id: null,
        reason: "adapter_unsupported",
      },
    ]);
  });

  it("warns about unknown features, areas and roles instead of failing", async () => {
    const preview = await client.preview(
      client.planBody({
        selection: {
          feature_ids: ["smart_log.read.open_maintenance", "nope.read.missing"],
          area_ids: ["Nowhere"],
          roles: ["guest", "ghost"],
        },
      }),
    );
    expect(preview.cells_total).toBe(2);
    expect(preview.warnings).toEqual([
      "Feature nope.read.missing is not in bundle v2 and was ignored",
      "Area Nowhere is not in bundle v2 and was ignored",
      "Role ghost is not in bundle v2 and was ignored",
    ]);
  });

  it("answers an empty selection with zero cells and a warning, not an error", async () => {
    const preview = await client.preview(
      client.planBody({ selection: { feature_ids: [], area_ids: [] } }),
    );
    expect(preview.cells_total).toBe(0);
    expect(preview.scenarios_estimated).toBe(0);
    expect(preview.warnings).toContain("The selection matches no feature of the bundle");
  });

  it("marks write features of a production target as production_blocked", async () => {
    await client.control.productionTarget(true);
    const preview = await client.preview(
      client.planBody({
        target_id: STAGE_ONE_IDS.liveShop,
        selection: {
          feature_ids: ["smart_log.read.open_maintenance", "smart_log.write.close_issue"],
          roles: ["housekeeping_lead"],
        },
      }),
    );
    expect(preview.skipped).toEqual([
      {
        feature_id: "smart_log.write.close_issue",
        role: null,
        interface_id: null,
        reason: "production_blocked",
      },
    ]);
    expect(preview.cells_total).toBe(3);
    expect(preview.scenarios_estimated).toBe(2);
    expect(preview.warnings[0]).toMatch(/production target/);
  });

  it("is open to the viewer role and needs a token", async () => {
    const response = await client.send("POST", "/api/v1/plans/preview", client.planBody(), {
      role: "viewer",
    });
    expect(response.status).toBe(200);
    const anonymous = await fetch(`${running.baseUrl}/api/v1/plans/preview`, { method: "POST" });
    expect(anonymous.status).toBe(401);
  });

  it("validates the body with field locations", async () => {
    const response = await client.send("POST", "/api/v1/plans/preview", {
      target_id: GRACIE_ID,
      saved: false,
      selection: {
        feature_ids: "x",
        interface_mode: "sideways",
        depth: "standard",
        k: 11,
        budget: { max_usd: -1 },
      },
    });
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("validation_failed");
    const locations = error.details.map((detail) => JSON.stringify(detail.loc));
    expect(locations).toEqual(
      expect.arrayContaining([
        '["body","selection","feature_ids"]',
        '["body","selection","interface_mode"]',
        '["body","selection","depth"]',
        '["body","selection","k"]',
        '["body","selection","budget","max_usd"]',
        '["body","selection","budget","max_minutes"]',
      ]),
    );
  });

  it("rejects k below 1, a missing saved flag and an unknown target", async () => {
    const lowK = await client.send(
      "POST",
      "/api/v1/plans/preview",
      client.planBody({ selection: { k: 0 } }),
    );
    expect((await errorOf(lowK)).details[0]?.code).toBe("greater_than_equal");
    const noSaved = await client.send("POST", "/api/v1/plans/preview", {
      target_id: GRACIE_ID,
      selection: client.selection(),
    });
    expect((await errorOf(noSaved)).details[0]).toMatchObject({ loc: ["body", "saved"] });
    const unknown = await client.send(
      "POST",
      "/api/v1/plans/preview",
      client.planBody({ target_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9999" }),
    );
    expect(unknown.status).toBe(404);
  });

  it("answers 409 target_not_ready for a target without a valid bundle", async () => {
    const response = await client.send(
      "POST",
      "/api/v1/plans/preview",
      client.planBody({ target_id: STAGE_ONE_IDS.billing }),
    );
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("target_not_ready");
    expect(error.details[0]).toMatchObject({ loc: ["bundle"], code: "bundle_missing" });
  });
});

describe("POST /plans", () => {
  it("saves a plan with 201 and the full Plan shape", async () => {
    const body = client.planBody({
      name: "Smart Log guest",
      saved: true,
      selection: { budget: { max_usd: 2, max_minutes: 15 }, k: 3 },
    });
    const response = await client.send("POST", "/api/v1/plans", body);
    expect(response.status).toBe(201);
    const plan = (await response.json()) as Plan;
    expect(plan).toMatchObject({
      target_id: GRACIE_ID,
      name: "Smart Log guest",
      saved: true,
      effective_budget: { max_usd: 2, max_minutes: 15 },
      is_coverage_baseline: false,
      cells_total: 2,
      schedule_id: null,
    });
    expect(plan.selection).toEqual(body.selection);
    expect(plan.bundle_id).toBe(mockState.stageOne.latestValidBundle(GRACIE_ID)?.bundle.id);
    const read = await client.get(`/api/v1/plans/${plan.id}`);
    expect(await read.json()).toEqual(plan);
  });

  it("applies the default budget when the selection has none and omits the key", async () => {
    const plan = await client.createPlan(client.planBody({ saved: true }));
    expect(plan.effective_budget).toEqual({ max_usd: 5, max_minutes: 30 });
    expect("budget" in plan.selection).toBe(false);
  });

  it("answers 422 plan_empty when the selection expands to nothing", async () => {
    const response = await client.send(
      "POST",
      "/api/v1/plans",
      client.planBody({ saved: true, selection: { feature_ids: [], area_ids: [] } }),
    );
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("plan_empty");
  });

  it("needs the member role", async () => {
    const response = await client.send("POST", "/api/v1/plans", client.planBody({ saved: true }), {
      role: "viewer",
    });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("role_required");
  });

  it("replays and conflicts on an Idempotency-Key when one is sent", async () => {
    const body = client.planBody({ saved: true, name: "Keyed" });
    const headers = { "Idempotency-Key": "plan-key-000001" };
    const first = await client.send("POST", "/api/v1/plans", body, { headers });
    const second = await client.send("POST", "/api/v1/plans", body, { headers });
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    const different = await client.send(
      "POST",
      "/api/v1/plans",
      client.planBody({ saved: true, name: "Other" }),
      { headers },
    );
    expect(different.status).toBe(409);
    expect((await errorOf(different)).code).toBe("idempotency_conflict");
  });
});

describe("GET /plans", () => {
  it("lists the seeded plans newest first with include_total", async () => {
    const response = await client.get("/api/v1/plans?include_total=true");
    const page = (await response.json()) as PlanPage;
    expect(page.total).toBe(4);
    expect(page.items.map((plan) => plan.id)).toEqual([
      STAGE_TWO_IDS.plans.lowBudget,
      STAGE_TWO_IDS.plans.apiSweep,
      STAGE_TWO_IDS.plans.guestFlows,
      STAGE_TWO_IDS.plans.smartLog,
    ]);
    expect(page.next_cursor).toBeNull();
  });

  it("filters by saved and target_id and paginates by cursor", async () => {
    const saved = (await (
      await client.get("/api/v1/plans?saved=true&sort=created_at")
    ).json()) as PlanPage;
    expect(saved.items.map((plan) => plan.name)).toEqual([
      "Smart Log reads",
      "Guest flows in the browser",
      "API sweep, two attempts",
    ]);
    const unsaved = (await (await client.get("/api/v1/plans?saved=false")).json()) as PlanPage;
    expect(unsaved.items).toHaveLength(1);
    const none = (await (
      await client.get(`/api/v1/plans?target_id=${STAGE_ONE_IDS.billing}`)
    ).json()) as PlanPage;
    expect(none.items).toEqual([]);

    const first = (await (await client.get("/api/v1/plans?limit=3")).json()) as PlanPage;
    expect(first.items).toHaveLength(3);
    const cursor = first.next_cursor;
    expect(cursor).not.toBeNull();
    const second = (await (
      await client.get(`/api/v1/plans?limit=3&cursor=${cursor}`)
    ).json()) as PlanPage;
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
  });

  it("rejects unknown filters and sort keys with 422", async () => {
    const unknown = await client.get("/api/v1/plans?colour=red");
    expect(unknown.status).toBe(422);
    expect((await errorOf(unknown)).details[0]?.loc).toEqual(["query", "colour"]);
    const sort = await client.get("/api/v1/plans?sort=name");
    expect(sort.status).toBe(422);
  });

  it("hides saved=false plans only when asked, and starts empty on the empty seed", async () => {
    await client.control.seed("empty");
    const page = (await (await client.get("/api/v1/plans")).json()) as PlanPage;
    expect(page.items).toEqual([]);
  });
});

describe("GET, PATCH and DELETE /plans/{id}", () => {
  it("reads one plan and answers 404 for an unknown id", async () => {
    const response = await client.get(`/api/v1/plans/${STAGE_TWO_IDS.plans.smartLog}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Plan).selection.feature_ids).toEqual([
      "smart_log.read.open_maintenance",
      "smart_log.read.issue_detail",
    ]);
    const missing = await client.get("/api/v1/plans/0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff");
    expect(missing.status).toBe(404);
    const malformed = await client.get("/api/v1/plans/not-a-uuid");
    expect(malformed.status).toBe(422);
  });

  it("renames, clears the name with null and re-expands a new selection", async () => {
    const id = STAGE_TWO_IDS.plans.smartLog;
    const renamed = await client.send("PATCH", `/api/v1/plans/${id}`, { name: "Renamed" });
    expect(((await renamed.json()) as Plan).name).toBe("Renamed");
    const cleared = await client.send("PATCH", `/api/v1/plans/${id}`, { name: null });
    expect(((await cleared.json()) as Plan).name).toBeNull();
    const reselected = await client.send("PATCH", `/api/v1/plans/${id}`, {
      selection: client.selection({
        roles: ["guest"],
        budget: { max_usd: 9, max_minutes: 45 },
      }),
    });
    const plan = (await reselected.json()) as Plan;
    expect(plan.cells_total).toBe(2);
    expect(plan.effective_budget).toEqual({ max_usd: 9, max_minutes: 45 });
  });

  it("rejects a selection that expands to nothing and an empty name", async () => {
    const id = STAGE_TWO_IDS.plans.smartLog;
    const empty = await client.send("PATCH", `/api/v1/plans/${id}`, {
      selection: client.selection({ feature_ids: [] }),
    });
    expect((await errorOf(empty)).code).toBe("plan_empty");
    const blank = await client.send("PATCH", `/api/v1/plans/${id}`, { name: "   " });
    expect(blank.status).toBe(422);
  });

  it("needs the member role to change or delete", async () => {
    const id = STAGE_TWO_IDS.plans.smartLog;
    expect((await client.send("PATCH", `/api/v1/plans/${id}`, {}, { role: "viewer" })).status).toBe(
      403,
    );
    expect(
      (await client.send("DELETE", `/api/v1/plans/${id}`, undefined, { role: "viewer" })).status,
    ).toBe(403);
  });

  it("deletes with 204 and then answers 404", async () => {
    const id = STAGE_TWO_IDS.plans.guestFlows;
    const deleted = await client.send("DELETE", `/api/v1/plans/${id}`);
    expect(deleted.status).toBe(204);
    expect((await client.get(`/api/v1/plans/${id}`)).status).toBe(404);
  });
});

describe("GET /plans/{id}/cells", () => {
  it("lists the cells of a plan with statuses and filters", async () => {
    const id = STAGE_TWO_IDS.plans.smartLog;
    const page = (await (
      await client.get(`/api/v1/plans/${id}/cells?include_total=true`)
    ).json()) as CoverageCellPage;
    expect(page.total).toBe(12);
    expect(page.items[0]).toMatchObject({
      plan_id: id,
      family: "smart-log",
      status: "covered",
      scenario_count: 1,
      reason: null,
      skip_reason: null,
    });
    const filtered = (await (
      await client.get(
        `/api/v1/plans/${id}/cells?feature_id=smart_log.read.issue_detail&status=covered`,
      )
    ).json()) as CoverageCellPage;
    expect(filtered.items.map((cell) => cell.role)).toEqual(["housekeeping_lead", "manager"]);
    const invalid = await client.get(`/api/v1/plans/${id}/cells?status=sleeping`);
    expect(invalid.status).toBe(422);
  });

  it("marks cells generated before any run covered them", async () => {
    const plan = await client.createPlan(client.planBody({ saved: true }));
    const page = (await (
      await client.get(`/api/v1/plans/${plan.id}/cells`)
    ).json()) as CoverageCellPage;
    expect(new Set(page.items.map((cell) => cell.status))).toEqual(new Set(["generated"]));
    expect(page.items.every((cell) => cell.last_verdict === null)).toBe(true);
  });
});

describe("preview result shape", () => {
  it("is typed as PlanPreview", async () => {
    const preview: PlanPreview = await client.preview(client.planBody());
    expect(Object.keys(preview).sort()).toEqual([
      "cells_total",
      "effective_budget",
      "estimated_cost_usd",
      "scenarios_estimated",
      "skipped",
      "warnings",
    ]);
  });
});
