import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  OracleResult,
  OracleResultPage,
  OracleTemplate,
  OracleTemplatePage,
} from "@/lib/api/types";
import { ORACLE_RESULT_IDS, ORACLE_TEMPLATE_IDS } from "@/mocks/fixtures/oracle-templates";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage1Client,
  errorOf,
  STAGE_ONE_IDS,
  type Stage1Client,
} from "@/tests/utils/stage1";

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
const TEMPLATES = "/api/v1/oracle-templates";
const OPEN_MAINTENANCE = ORACLE_TEMPLATE_IDS.openMaintenance;
const VALID_PARAMS = { tenant_id: "gracie-demo", as_of: "2026-10-01", role: "front_desk" };
const SETTLE_WAIT_MS = 400;

function newKey(): Record<string, string> {
  return { "Idempotency-Key": crypto.randomUUID() };
}

async function listTemplates(query = ""): Promise<OracleTemplatePage> {
  const response = await client.get(`${TEMPLATES}${query}`, "viewer");
  expect(response.status).toBe(200);
  return (await response.json()) as OracleTemplatePage;
}

async function startRun(
  templateId: string,
  params: Record<string, unknown> = VALID_PARAMS,
  headers: Record<string, string> = newKey(),
): Promise<Response> {
  return client.send("POST", `${TEMPLATES}/${templateId}/runs`, { params }, { headers });
}

async function readResult(resultId: string): Promise<OracleResult> {
  const response = await client.get(`/api/v1/oracle-results/${resultId}`, "viewer");
  expect(response.status).toBe(200);
  return (await response.json()) as OracleResult;
}

async function runToSettled(
  templateId: string,
  params: Record<string, unknown> = VALID_PARAMS,
): Promise<OracleResult> {
  mockState.stageThree.oracle.configure({ settleMs: 0 });
  const started = (await (await startRun(templateId, params)).json()) as OracleResult;
  return readResult(started.id);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("GET /oracle-templates", () => {
  it("lists the seeded templates of the latest valid bundle sorted by name", async () => {
    const page = await listTemplates(`?target_id=${GRACIE}`);

    expect(page.items.map((template) => template.name)).toEqual(
      [...page.items.map((template) => template.name)].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(page.items).toHaveLength(11);
    expect(page.next_cursor).toBeNull();
    expect(page.total).toBeNull();
    const bundleIds = new Set(page.items.map((template) => template.bundle_id));
    expect(bundleIds.size).toBe(1);
    expect(mockState.stageOne.latestValidBundle(GRACIE)?.bundle.id).toBe([...bundleIds][0]);
  });

  it("covers sql and python templates, every approval and read_only_verified true and false", async () => {
    const { items } = await listTemplates();

    expect(new Set(items.map((template) => template.language))).toEqual(new Set(["sql", "python"]));
    expect(new Set(items.map((template) => template.approval))).toEqual(
      new Set(["unreviewed", "approved", "rejected"]),
    );
    expect(items.filter((template) => !template.read_only_verified).map((t) => t.name)).toEqual([
      "refresh_room_snapshot",
    ]);
  });

  it("gives open_maintenance a params schema with tenant, date and role", async () => {
    const template = (await (
      await client.get(`${TEMPLATES}/${OPEN_MAINTENANCE}`, "viewer")
    ).json()) as OracleTemplate;

    expect(template.params_schema).toMatchObject({
      required: ["tenant_id", "as_of", "role"],
      properties: {
        tenant_id: { type: "string" },
        as_of: { type: "string", format: "date" },
        role: { enum: ["front_desk", "housekeeping_lead", "manager"] },
      },
    });
    expect(template).toMatchObject({
      name: "open_maintenance",
      language: "sql",
      approval: "unreviewed",
      read_only_verified: true,
      feature_ids: ["smart_log.read.open_maintenance"],
    });
  });

  it("filters by feature_id, repeated approval values and bundle_id", async () => {
    const byFeature = await listTemplates("?feature_id=reports.read.occupancy_summary");
    expect(byFeature.items.map((template) => template.name).sort()).toEqual([
      "legacy_room_status",
      "rooms_inventory",
      "slow_occupancy_report",
    ]);

    const approved = await listTemplates("?approval=approved");
    expect(approved.items.map((template) => template.name).sort()).toEqual([
      "issue_detail",
      "staff_roster",
    ]);

    const both = await listTemplates("?approval=approved&approval=rejected");
    expect(both.items).toHaveLength(3);

    const bundleId = mockState.stageOne.latestValidBundle(GRACIE)?.bundle.id ?? "";
    expect((await listTemplates(`?bundle_id=${bundleId}`)).items).toHaveLength(11);
    expect((await listTemplates(`?bundle_id=${MISSING_ID}`)).items).toEqual([]);
  });

  it("paginates with a cursor and honours include_total", async () => {
    const first = await listTemplates("?limit=4&include_total=true");
    expect(first.items).toHaveLength(4);
    expect(first.total).toBe(11);
    expect(first.next_cursor).not.toBeNull();

    const second = await listTemplates(`?limit=4&cursor=${first.next_cursor}`);
    const third = await listTemplates(`?limit=4&cursor=${second.next_cursor}`);
    expect(third.next_cursor).toBeNull();
    const names = [...first.items, ...second.items, ...third.items].map((item) => item.name);
    expect(new Set(names).size).toBe(11);
  });

  it("returns nothing for a target without a valid bundle and for the empty seed", async () => {
    expect((await listTemplates(`?target_id=${BILLING}`)).items).toEqual([]);

    mockState.stageThree.reset("empty");
    expect((await listTemplates(`?target_id=${GRACIE}`)).items).toEqual([]);
  });

  it("answers 404 for an unknown target and 422 for unknown parameters and values", async () => {
    const unknownTarget = await client.get(`${TEMPLATES}?target_id=${MISSING_ID}`, "viewer");
    expect(unknownTarget.status).toBe(404);

    const badApproval = await client.get(`${TEMPLATES}?approval=maybe`, "viewer");
    expect(badApproval.status).toBe(422);
    expect((await errorOf(badApproval)).details[0]).toMatchObject({
      loc: ["query", "approval", 0],
      code: "enum",
    });

    const badParameter = await client.get(`${TEMPLATES}?colour=red`, "viewer");
    expect(badParameter.status).toBe(422);
  });

  it("needs a token but not a role above viewer", async () => {
    expect((await fetch(`${running.baseUrl}${TEMPLATES}`)).status).toBe(401);
    expect((await client.get(TEMPLATES, "viewer")).status).toBe(200);
  });
});

describe("GET /oracle-templates/{id}", () => {
  it("returns one template and 404 or 422 for unknown and malformed ids", async () => {
    const found = await client.get(`${TEMPLATES}/${ORACLE_TEMPLATE_IDS.staffRoster}`, "viewer");
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ name: "staff_roster", language: "python" });

    expect((await client.get(`${TEMPLATES}/${MISSING_ID}`, "viewer")).status).toBe(404);
    expect((await client.get(`${TEMPLATES}/not-a-uuid`, "viewer")).status).toBe(422);
  });
});

describe("POST /oracle-templates/{id}/runs", () => {
  it("returns 202 with a pending result and settles to ok with rows and a sentence", async () => {
    const response = await startRun(OPEN_MAINTENANCE);

    expect(response.status).toBe(202);
    const pending = (await response.json()) as OracleResult;
    expect(pending).toMatchObject({
      oracle_template_id: OPEN_MAINTENANCE,
      params: VALID_PARAMS,
      status: "pending",
      rows: [],
      rows_truncated: false,
      sentence: null,
      error: null,
      duration_ms: null,
      executed_at: null,
    });

    await wait(SETTLE_WAIT_MS);
    const settled = await readResult(pending.id);
    expect(settled.status).toBe("ok");
    expect(settled.rows).toHaveLength(4);
    expect(settled.sentence).toBe(
      "4 maintenance issues are open for gracie-demo on 2026-10-01; the newest is in room 412 (plumbing).",
    );
    expect(settled.duration_ms).toBe(42);
    expect(settled.executed_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("keeps the slow template pending for about two seconds before it turns ok", async () => {
    const started = (await (
      await startRun(ORACLE_TEMPLATE_IDS.slowOccupancy, {
        tenant_id: "gracie-demo",
        as_of: "2026-10-01",
      })
    ).json()) as OracleResult;

    expect((await readResult(started.id)).status).toBe("pending");
    await wait(1000);
    expect((await readResult(started.id)).status).toBe("pending");
    await wait(1200);
    const settled = await readResult(started.id);
    expect(settled.status).toBe("ok");
    expect(settled.rows).toHaveLength(8);
  });

  it("returns 200 rows with rows_truncated for the cut export and one row for a detail query", async () => {
    const truncated = await runToSettled(ORACLE_TEMPLATE_IDS.guestRequestsExport, {
      tenant_id: "gracie-demo",
    });
    expect(truncated.rows).toHaveLength(200);
    expect(truncated.rows_truncated).toBe(true);

    const single = await runToSettled(ORACLE_TEMPLATE_IDS.issueDetail, {
      tenant_id: "gracie-demo",
      issue_id: 1042,
    });
    expect(single.rows).toHaveLength(1);
    expect(single.rows_truncated).toBe(false);
    expect(single.sentence).toBe("Issue 1042 is a plumbing issue and its status is open.");
  });

  it("settles an empty result as ok with no rows and a sentence", async () => {
    const empty = await runToSettled(ORACLE_TEMPLATE_IDS.lateCheckouts, {
      tenant_id: "gracie-demo",
      as_of: "2026-10-01",
    });

    expect(empty).toMatchObject({ status: "ok", rows: [], rows_truncated: false });
    expect(empty.sentence).toBe("No late checkouts are expected for gracie-demo on 2026-10-01.");
  });

  it("returns ragged and nested rows for the python template", async () => {
    const result = await runToSettled(ORACLE_TEMPLATE_IDS.staffRoster, {
      tenant_id: "gracie-demo",
    });

    const keys = new Set(result.rows.flatMap((row) => Object.keys(row)));
    expect(keys).toEqual(new Set(["display_name", "shifts", "contact", "notes", "badge"]));
    expect(result.rows[0]?.contact).toEqual({
      phone: "555-0100",
      email: "maya.rossi@gracie.example",
    });
    expect(result.rows[1]).not.toHaveProperty("contact");
    expect(result.rows[2]?.contact).toBeNull();
  });

  it("settles the failing template as error with a message and no rows", async () => {
    const result = await runToSettled(ORACLE_TEMPLATE_IDS.failingExport, {
      tenant_id: "gracie-demo",
    });

    expect(result).toMatchObject({
      status: "error",
      rows: [],
      sentence: null,
      duration_ms: 10000,
    });
    expect(result.error).toContain("statement timeout");
  });

  it("makes every run fail while the oracle_error fault is on", async () => {
    mockState.faults.apply({ oracle_error: true });

    const result = await runToSettled(OPEN_MAINTENANCE);

    expect(result.status).toBe("error");
    expect(result.error).toBe("The oracle worker could not reach the truth database");

    mockState.faults.apply({ oracle_error: null });
    expect((await runToSettled(OPEN_MAINTENANCE)).status).toBe("ok");
  });

  it("honours the limit parameter and keeps html-looking text as plain strings", async () => {
    const result = await runToSettled(OPEN_MAINTENANCE, { ...VALID_PARAMS, limit: 3 });

    expect(result.rows).toHaveLength(3);
    expect(result.rows[2]?.category).toBe("<img src=x onerror=alert(1)>");
  });

  it("requires the Idempotency-Key header and replays the same result for the same key", async () => {
    const missing = await startRun(OPEN_MAINTENANCE, VALID_PARAMS, {});
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("idempotency_key_required");

    const headers = newKey();
    const first = await startRun(OPEN_MAINTENANCE, VALID_PARAMS, headers);
    const replay = await startRun(OPEN_MAINTENANCE, VALID_PARAMS, headers);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(((await replay.json()) as OracleResult).id).toBe(
      ((await first.json()) as OracleResult).id,
    );

    const different = await startRun(OPEN_MAINTENANCE, { ...VALID_PARAMS, limit: 2 }, headers);
    expect(different.status).toBe(409);
    expect((await errorOf(different)).code).toBe("idempotency_conflict");
  });

  it("validates params against the schema with details under body.params", async () => {
    const response = await startRun(OPEN_MAINTENANCE, {
      tenant_id: "x",
      as_of: "2026-13-45",
      role: "guest",
      limit: 0,
      extra: true,
    });

    expect(response.status).toBe(422);
    const { code, details } = await errorOf(response);
    expect(code).toBe("validation_failed");
    expect(details.map((detail) => [detail.loc.join("."), detail.code])).toEqual([
      ["body.params.tenant_id", "string_too_short"],
      ["body.params.as_of", "date_from_datetime_parsing"],
      ["body.params.role", "enum"],
      ["body.params.limit", "greater_than_equal"],
      ["body.params.extra", "extra_forbidden"],
    ]);
  });

  it("reports missing required params and a missing or malformed params object", async () => {
    const missingFields = await startRun(OPEN_MAINTENANCE, { tenant_id: "gracie-demo" });
    expect((await errorOf(missingFields)).details.map((detail) => detail.loc.join("."))).toEqual([
      "body.params.as_of",
      "body.params.role",
    ]);

    const noParams = await client.send(
      "POST",
      `${TEMPLATES}/${OPEN_MAINTENANCE}/runs`,
      {},
      {
        headers: newKey(),
      },
    );
    expect((await errorOf(noParams)).details[0]).toMatchObject({
      loc: ["body", "params"],
      code: "missing",
    });

    const notAnObject = await client.send(
      "POST",
      `${TEMPLATES}/${OPEN_MAINTENANCE}/runs`,
      { params: "tenant" },
      { headers: newKey() },
    );
    expect((await errorOf(notAnObject)).details[0]?.loc).toEqual(["body", "params"]);
  });

  it("accepts any object for a schema outside the supported subset", async () => {
    const response = await startRun(ORACLE_TEMPLATE_IDS.escalationRules, {
      tenant_id: "gracie-demo",
      severities: ["high"],
    });

    expect(response.status).toBe(202);
  });

  it("is forbidden for viewers and 404 for an unknown template", async () => {
    const forbidden = await client.send(
      "POST",
      `${TEMPLATES}/${OPEN_MAINTENANCE}/runs`,
      { params: VALID_PARAMS },
      { role: "viewer", headers: newKey() },
    );
    expect(forbidden.status).toBe(403);
    expect((await errorOf(forbidden)).code).toBe("role_required");

    expect((await startRun(MISSING_ID)).status).toBe(404);
  });

  it("lets a member run a template", async () => {
    const response = await client.send(
      "POST",
      `${TEMPLATES}/${OPEN_MAINTENANCE}/runs`,
      { params: VALID_PARAMS },
      { role: "member", headers: newKey() },
    );

    expect(response.status).toBe(202);
  });
});

describe("GET /oracle-results/{id}", () => {
  it("returns a seeded result and 404 or 422 for unknown and malformed ids", async () => {
    const result = await readResult(ORACLE_RESULT_IDS.openMaintenanceOk);

    expect(result).toMatchObject({
      status: "ok",
      oracle_template_id: OPEN_MAINTENANCE,
      executed_at: "2026-10-02T08:15:03.000Z",
    });
    expect(result.rows).toHaveLength(4);

    expect((await client.get(`/api/v1/oracle-results/${MISSING_ID}`, "viewer")).status).toBe(404);
    expect((await client.get(`/api/v1/oracle-results/nope`, "viewer")).status).toBe(422);
  });

  it("returns a seeded error result", async () => {
    const result = await readResult(ORACLE_RESULT_IDS.openMaintenanceError);

    expect(result.status).toBe("error");
    expect(result.error).toBeTruthy();
    expect(result.rows).toEqual([]);
  });
});

describe("GET /oracle-templates/{id}/results", () => {
  it("lists the history newest first and includes a new run", async () => {
    const before = (await (
      await client.get(`${TEMPLATES}/${OPEN_MAINTENANCE}/results`, "viewer")
    ).json()) as OracleResultPage;
    expect(before.items.map((item) => item.id)).toEqual([
      ORACLE_RESULT_IDS.openMaintenanceOk,
      ORACLE_RESULT_IDS.openMaintenanceError,
    ]);

    const started = (await (await startRun(OPEN_MAINTENANCE)).json()) as OracleResult;
    const after = (await (
      await client.get(`${TEMPLATES}/${OPEN_MAINTENANCE}/results`, "viewer")
    ).json()) as OracleResultPage;
    expect(after.items[0]).toMatchObject({ id: started.id, status: "pending" });
    expect(after.items).toHaveLength(3);
  });

  it("answers an empty page for a template without runs and 404 for an unknown template", async () => {
    const empty = (await (
      await client.get(`${TEMPLATES}/${ORACLE_TEMPLATE_IDS.roomsInventory}/results`, "viewer")
    ).json()) as OracleResultPage;
    expect(empty).toEqual({ items: [], next_cursor: null, total: null });

    expect((await client.get(`${TEMPLATES}/${MISSING_ID}/results`, "viewer")).status).toBe(404);
  });
});

describe("PUT /oracle-templates/{id}/approval", () => {
  function approval(
    templateId: string,
    body: unknown,
    role: "admin" | "member" | "viewer" = "member",
  ): Promise<Response> {
    return client.send("PUT", `${TEMPLATES}/${templateId}/approval`, body, { role });
  }

  it("approves after an ok result and returns the updated template", async () => {
    const result = await runToSettled(OPEN_MAINTENANCE);

    const response = await approval(OPEN_MAINTENANCE, {
      approved: true,
      oracle_result_id: result.id,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: OPEN_MAINTENANCE, approval: "approved" });
    const reread = (await (
      await client.get(`${TEMPLATES}/${OPEN_MAINTENANCE}`, "viewer")
    ).json()) as OracleTemplate;
    expect(reread.approval).toBe("approved");
  });

  it("rejects a template and lets an approved one be rejected later", async () => {
    const result = await runToSettled(ORACLE_TEMPLATE_IDS.issueDetail, {
      tenant_id: "gracie-demo",
      issue_id: 7,
    });

    const response = await approval(ORACLE_TEMPLATE_IDS.issueDetail, {
      approved: false,
      oracle_result_id: result.id,
    });

    expect(await response.json()).toMatchObject({ approval: "rejected" });
  });

  it("refuses to approve a template that is not read-only verified", async () => {
    const result = await runToSettled(ORACLE_TEMPLATE_IDS.rawSqlProbe, {
      tenant_id: "gracie-demo",
    });

    const response = await approval(ORACLE_TEMPLATE_IDS.rawSqlProbe, {
      approved: true,
      oracle_result_id: result.id,
    });

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("conflict");
  });

  it("refuses a pending or failed result", async () => {
    mockState.stageThree.oracle.configure({ settleMs: 5000 });
    const pending = (await (await startRun(OPEN_MAINTENANCE)).json()) as OracleResult;
    const whilePending = await approval(OPEN_MAINTENANCE, {
      approved: true,
      oracle_result_id: pending.id,
    });
    expect(whilePending.status).toBe(409);

    const failed = await approval(OPEN_MAINTENANCE, {
      approved: true,
      oracle_result_id: ORACLE_RESULT_IDS.openMaintenanceError,
    });
    expect(failed.status).toBe(409);
  });

  it("validates the body and the ownership of the result", async () => {
    const missing = await approval(OPEN_MAINTENANCE, {});
    expect(missing.status).toBe(422);
    expect((await errorOf(missing)).details.map((detail) => detail.loc.join("."))).toEqual([
      "body.approved",
      "body.oracle_result_id",
    ]);

    const foreign = await approval(OPEN_MAINTENANCE, {
      approved: true,
      oracle_result_id: ORACLE_RESULT_IDS.issueDetailOk,
    });
    expect(foreign.status).toBe(422);
    expect((await errorOf(foreign)).details[0]).toMatchObject({
      loc: ["body", "oracle_result_id"],
      code: "oracle_result_not_found",
    });
  });

  it("is forbidden for viewers and 404 for an unknown template", async () => {
    const forbidden = await approval(
      OPEN_MAINTENANCE,
      { approved: true, oracle_result_id: ORACLE_RESULT_IDS.openMaintenanceOk },
      "viewer",
    );
    expect(forbidden.status).toBe(403);

    const unknown = await approval(MISSING_ID, {
      approved: true,
      oracle_result_id: ORACLE_RESULT_IDS.openMaintenanceOk,
    });
    expect(unknown.status).toBe(404);
  });
});

describe("POST /__mock/stage3/seed", () => {
  async function control(body: unknown): Promise<Response> {
    return fetch(`${running.baseUrl}/__mock/stage3/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("empties and restores the oracle templates and reports counts", async () => {
    const emptied = await control({ seed: "empty" });
    expect(await emptied.json()).toEqual({
      seed: "empty",
      oracle: { templates: 0, results: 0, settle_ms: null },
    });
    expect((await listTemplates()).items).toEqual([]);

    const restored = await control({ seed: "default" });
    expect(((await restored.json()) as { oracle: { templates: number } }).oracle.templates).toBe(
      11,
    );
    expect((await listTemplates()).items).toHaveLength(11);
  });

  it("overrides the settle delay of new runs", async () => {
    await control({ oracle_settle_ms: 0 });
    const started = (await (await startRun(OPEN_MAINTENANCE)).json()) as OracleResult;

    expect((await readResult(started.id)).status).toBe("ok");

    await control({ oracle_settle_ms: null });
    expect(mockState.stageThree.oracle.settleOverrideMs).toBeNull();
  });

  it("rejects an empty body, unknown keys and a negative delay", async () => {
    expect((await control({})).status).toBe(422);
    expect((await control({ seed: "default", colour: "red" })).status).toBe(422);
    expect((await control({ oracle_settle_ms: -1 })).status).toBe(422);
  });

  it("is restored by /__mock/reset together with the other stages", async () => {
    mockState.stageThree.reset("empty");
    await fetch(`${running.baseUrl}/__mock/reset`, { method: "POST" });

    expect((await listTemplates()).items).toHaveLength(11);
  });
});
