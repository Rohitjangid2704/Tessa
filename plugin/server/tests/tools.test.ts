import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { stringify } from "yaml";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BASE_URL,
  IDS,
  TARGET_TOKEN,
  TOKEN,
  TOKEN_PREFIX,
  bundleDiff,
  environment,
  errorBody,
  explanationCreated,
  finding,
  healthReport,
  proposal,
  proposalDoc,
  repro,
  run,
  runConfigSnapshot,
  runStats,
  step,
  target,
  validationReport,
} from "./fixtures";
import { createHarness, mswServer, requestsTo, resetSeen, seen, type Harness } from "./harness";

const API = `${BASE_URL}/api/v1`;

let harness: Harness;
let bundleRoot: string;

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());

beforeEach(async () => {
  resetSeen();
  harness = createHarness();
  bundleRoot = await mkdtemp(join(tmpdir(), "tessa-tools-"));
  const folder = join(bundleRoot, "tessa");
  await mkdir(join(folder, "scenarios"), { recursive: true });
  await writeFile(join(folder, "manifest.yaml"), `target_token: ${TARGET_TOKEN}\napp:\n  name: Demo\n`);
  await writeFile(join(folder, "scenarios", "a.yaml"), "id: a\n");
  await writeFile(join(folder, ".env"), "SECRET_VALUE=do-not-upload\n");
  await writeFile(join(folder, "proposal.yaml"), stringify(proposalDoc(2)));
});

afterEach(async () => {
  await rm(bundleRoot, { recursive: true, force: true });
});

describe("session tools", () => {
  it("whoami returns the user, the token prefix and never the token", async () => {
    const result = await harness.call("whoami");
    expect(result.isError).toBe(false);
    expect(result.body.user).toEqual({
      id: IDS.user,
      name: "Eng Ineer",
      email: "engineer@example.test",
      role: "member",
    });
    expect(result.body.token_prefix).toBe(TOKEN_PREFIX);
    expect(result.body.api_url).toBe(BASE_URL);
    expect(result.text).not.toContain(TOKEN);
  });

  it("list_targets maps the page and forwards the filters", async () => {
    const result = await harness.call("list_targets", { query: "graph", limit: 10 });
    expect(result.body.targets).toEqual([
      {
        id: IDS.target,
        name: "GraphQL Fixture",
        slug: "graphql-fixture",
        tier: "qa",
        app_kind: "api",
        latest_bundle_version: 3,
        completeness_score: 82,
        health: "ok",
        archived: false,
      },
    ]);
    expect(result.body.has_more).toBe(false);
    const request = requestsTo("GET", "/targets")[0];
    expect(request?.search).toContain("q=graph");
    expect(request?.search).toContain("limit=10");
  });

  it("get_target returns names and health, never values, and selects the target", async () => {
    await harness.session.start();
    const result = await harness.call("get_target", { target_id: IDS.target });
    expect(result.isError).toBe(false);
    expect(result.body.target.target_token).toBe(TARGET_TOKEN);
    expect(result.body.production).toBe(false);
    expect(result.body.latest_bundle.version).toBe(3);
    expect(result.body.environment.missing_required).toBe(1);
    expect(result.body.environment.variables.map((variable: { name: string }) => variable.name)).toEqual([
      "GRAPHQL_URL",
      "STAFF_TOKEN",
    ]);
    expect(result.body.proposal).toBeNull();
    expect(result.text).not.toContain("http://localhost:8521");
    expect(harness.session.state.targetId).toBe(IDS.target);
    const patches = requestsTo("PATCH", `/agent-sessions/${IDS.agentSession}`);
    expect(patches).toHaveLength(1);
  });

  it("get_target flags a production target", async () => {
    mswServer.use(
      http.get(`${API}/targets/:targetId`, () =>
        HttpResponse.json({ ...target, id: IDS.productionTarget, tier: "production", name: "Prod" }),
      ),
    );
    const result = await harness.call("get_target", { target_id: IDS.productionTarget });
    expect(result.body.production).toBe(true);
    expect(result.body.target.tier).toBe("production");
  });

  it("get_target summarises a proposal when there is one", async () => {
    mswServer.use(http.get(`${API}/targets/:targetId/proposal`, () => HttpResponse.json(proposal)));
    const result = await harness.call("get_target", { target_id: IDS.target });
    expect(result.body.proposal).toMatchObject({
      item_count: 3,
      stale: false,
      status_counts: { proposed: 2, selected: 1 },
    });
  });
});

describe("prompt tool", () => {
  it("issue_prompt posts the template and returns the text", async () => {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.post(`${API}/targets/:targetId/prompt-issues`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            target_id: IDS.target,
            target_token: TARGET_TOKEN,
            template_name: "explain",
            template_version: 1,
            issued_at: "2026-10-08T10:00:00Z",
            issued_by: IDS.user,
            params: {},
            text: "Explain this finding.",
          },
          { status: 201 },
        );
      }),
    );
    const result = await harness.call("issue_prompt", {
      target_id: IDS.target,
      template: "explain",
      params: { finding_id: IDS.finding },
    });
    expect(received).toEqual({ finding_id: IDS.finding, template_name: "explain" });
    expect(result.body).toMatchObject({
      template_name: "explain",
      template_version: 1,
      target_token: TARGET_TOKEN,
      text: "Explain this finding.",
      text_truncated: false,
    });
    expect(requestsTo("POST", `/targets/${IDS.target}/prompt-issues`)[0]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("issue_prompt cuts a very long prompt and says so", async () => {
    mswServer.use(
      http.post(`${API}/targets/:targetId/prompt-issues`, () =>
        HttpResponse.json(
          {
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            target_id: IDS.target,
            target_token: TARGET_TOKEN,
            template_name: "discovery",
            template_version: 2,
            issued_at: "2026-10-08T10:00:00Z",
            issued_by: IDS.user,
            params: {},
            text: "x".repeat(120_000),
          },
          { status: 201 },
        ),
      ),
    );
    const result = await harness.call("issue_prompt", { target_id: IDS.target, template: "discovery" });
    expect(result.body.text_truncated).toBe(true);
    expect(result.body.text.length).toBeLessThanOrEqual(55_000);
    expect(result.body.text_bytes).toBe(120_000);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(60_000);
  });
});

describe("bundle tools", () => {
  it("validate_bundle puts fixup items first and sends a zip without dotfiles", async () => {
    let fileName = "";
    let entries: string[] = [];
    let targetField: string | File | null = null;
    mswServer.use(
      http.post(`${API}/bundles/validate`, async ({ request }) => {
        const form = await request.formData();
        const file = form.get("file") as File;
        fileName = file.name;
        entries = Object.keys(unzipSync(new Uint8Array(await file.arrayBuffer())));
        targetField = form.get("target_id");
        return HttpResponse.json(validationReport);
      }),
    );
    await harness.session.selectTarget({ id: IDS.target, target_token: TARGET_TOKEN });
    const result = await harness.call("validate_bundle", { path: bundleRoot });
    expect(result.isError).toBe(false);
    expect(Object.keys(result.body)[0]).toBe("validation_status");
    expect(Object.keys(result.body)[1]).toBe("fixup_items");
    expect(result.body.fixup_items).toHaveLength(1);
    expect(result.body.errors.total).toBe(1);
    expect(fileName).toBe("tessa.zip");
    expect(entries).toEqual(["tessa/manifest.yaml", "tessa/proposal.yaml", "tessa/scenarios/a.yaml"]);
    expect(targetField).toBe(IDS.target);
    expect(result.body.zip.excluded).toEqual(["tessa/.env"]);
    expect(requestsTo("POST", "/bundles/validate")[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("validate_bundle sends no target_id when no target is selected", async () => {
    let targetField: string | File | null = "unset";
    mswServer.use(
      http.post(`${API}/bundles/validate`, async ({ request }) => {
        targetField = (await request.formData()).get("target_id");
        return HttpResponse.json(validationReport);
      }),
    );
    await harness.call("validate_bundle", { path: join(bundleRoot, "tessa") });
    expect(targetField).toBeNull();
  });

  it("upload_bundle returns the bundle and the dry run id and sends an idempotency key", async () => {
    const result = await harness.call("upload_bundle", { path: bundleRoot, note: "first pass" });
    expect(result.isError).toBe(false);
    expect(result.body.created).toBe(true);
    expect(result.body.dry_run_run_id).toBe(IDS.run);
    expect(result.body.bundle).toMatchObject({
      version: 4,
      validation_status: "valid",
      commit_sha: "abc1234",
      branch: "main",
      scenarios_imported: 2,
    });
    const request = requestsTo("POST", "/bundles")[0];
    expect(request?.headers["idempotency-key"]).toMatch(/^[\x21-\x7E]{8,128}$/);
  });

  it("upload_bundle refuses a manifest of another target before any request", async () => {
    await harness.session.selectTarget({ id: IDS.target, target_token: "tgt_someoneelse000000" });
    const result = await harness.call("upload_bundle", { path: bundleRoot });
    expect(result.isError).toBe(true);
    expect(result.body.error.code).toBe("target_mismatch");
    expect(requestsTo("POST", "/bundles")).toHaveLength(0);
  });

  it("get_bundle returns the bundle and the diff", async () => {
    const result = await harness.call("get_bundle", { bundle_id: IDS.bundle, against: IDS.run });
    expect(result.body.bundle.version).toBe(4);
    expect(result.body.diff.summary).toBe(bundleDiff.summary);
    expect(requestsTo("GET", `/bundles/${IDS.bundle}/diff`)[0]?.search).toContain(`against=${IDS.run}`);
  });

  it("get_bundle returns a null diff when there is none", async () => {
    mswServer.use(
      http.get(`${API}/bundles/:bundleId/diff`, () =>
        HttpResponse.json(errorBody("not_found", "no diff"), { status: 404 }),
      ),
    );
    const result = await harness.call("get_bundle", { bundle_id: IDS.bundle });
    expect(result.body.diff).toBeNull();
  });

  it("reports a missing folder as a local error", async () => {
    const result = await harness.call("validate_bundle", { path: join(bundleRoot, "nowhere") });
    expect(result.isError).toBe(true);
    expect(result.body.error.code).toBe("bundle_folder_not_found");
    expect(result.body.error.status).toBe(0);
  });
});

describe("environment tools", () => {
  it("get_environment never returns values", async () => {
    const result = await harness.call("get_environment", { target_id: IDS.target });
    expect(result.body.variables[0]).toEqual({
      name: "GRAPHQL_URL",
      kind: "url",
      required: true,
      secret: false,
      has_value: true,
      stale: false,
      purpose: "Base URL of the GraphQL server",
      interface_ids: ["graphql_api"],
      health: { status: "ok", checked_at: "2026-10-02T10:01:00Z", latency_ms: 12, message: null },
    });
    expect(result.text).not.toContain("localhost:8521");
  });

  it("set_environment sends explicit pairs and lists names only", async () => {
    let received: { set: Record<string, string>; clear: string[] } = { set: {}, clear: [] };
    mswServer.use(
      http.patch(`${API}/targets/:targetId/environment`, async ({ request }) => {
        received = (await request.json()) as typeof received;
        return HttpResponse.json(environment);
      }),
    );
    const result = await harness.call("set_environment", {
      target_id: IDS.target,
      values: { STAFF_TOKEN: "staff-secret-value-123", GRAPHQL_URL: "http://localhost:8521" },
      clear: ["OLD_NAME"],
    });
    expect(received).toEqual({
      set: { STAFF_TOKEN: "staff-secret-value-123", GRAPHQL_URL: "http://localhost:8521" },
      clear: ["OLD_NAME"],
    });
    expect(result.body.set).toEqual(["GRAPHQL_URL", "STAFF_TOKEN"]);
    expect(result.body.cleared).toEqual(["OLD_NAME"]);
    expect(result.body.missing_required_names).toEqual(["STAFF_TOKEN"]);
    expect(result.text).not.toContain("staff-secret-value-123");
  });

  it("set_environment masks a value that an error message echoes back", async () => {
    mswServer.use(
      http.patch(`${API}/targets/:targetId/environment`, () =>
        HttpResponse.json(errorBody("validation_failed", "bad value staff-secret-value-123 for STAFF_TOKEN"), {
          status: 422,
        }),
      ),
    );
    const result = await harness.call("set_environment", {
      target_id: IDS.target,
      values: { STAFF_TOKEN: "staff-secret-value-123" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("staff-secret-value-123");
    expect(result.body.error.code).toBe("validation_failed");
  });

  it("set_environment refuses an empty request", async () => {
    const result = await harness.call("set_environment", { target_id: IDS.target });
    expect(result.body.error.code).toBe("nothing_to_set");
    expect(requestsTo("PATCH", `/targets/${IDS.target}/environment`)).toHaveLength(0);
  });

  it("run_health_checks returns the report and passes interface ids", async () => {
    let received: unknown = "unset";
    mswServer.use(
      http.post(`${API}/targets/:targetId/health-checks`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json(healthReport);
      }),
    );
    const result = await harness.call("run_health_checks", {
      target_id: IDS.target,
      interface_ids: ["graphql_api"],
    });
    expect(received).toEqual({ interface_ids: ["graphql_api"] });
    expect(result.body.interfaces.map((entry: { status: string }) => entry.status)).toEqual(["ok", "failed"]);
    expect(result.body.interfaces[1].message).toBe("connection refused");
  });
});

describe("run tools", () => {
  it("start_run starts a saved plan", async () => {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.post(`${API}/runs`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { run_id: IDS.run, status: "queued", kind: "suite", workflow_id: "wf-1", created_at: "2026-10-08T10:00:00Z" },
          { status: 202 },
        );
      }),
    );
    const result = await harness.call("start_run", { plan_id: IDS.plan });
    expect(received.plan_id).toBe(IDS.plan);
    expect(result.body).toEqual({
      run_id: IDS.run,
      status: "queued",
      kind: "suite",
      workflow_id: "wf-1",
      created_at: "2026-10-08T10:00:00Z",
    });
    expect(requestsTo("POST", "/runs")[0]?.headers["idempotency-key"]).toMatch(/^[\x21-\x7E]{8,128}$/);
  });

  it("start_run sends a scenario subset with the target", async () => {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.post(`${API}/runs`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { run_id: IDS.run, status: "queued", kind: "suite", workflow_id: "wf-1", created_at: "2026-10-08T10:00:00Z" },
          { status: 202 },
        );
      }),
    );
    await harness.call("start_run", { target_id: IDS.target, scenario_ids: [IDS.scenario] });
    expect(received).toMatchObject({ target_id: IDS.target, scenario_ids: [IDS.scenario] });
    expect(received.plan_id).toBeUndefined();
  });

  it.each([
    ["nothing", {}],
    ["two modes", { plan_id: IDS.plan, scenario_ids: [IDS.scenario], target_id: IDS.target }],
    ["subset without target", { scenario_ids: [IDS.scenario] }],
  ])("start_run rejects %s before any request", async (_name, args) => {
    const result = await harness.call("start_run", args);
    expect(result.isError).toBe(true);
    expect(result.body.error.code).toBe("invalid_arguments");
    expect(requestsTo("POST", "/runs")).toHaveLength(0);
  });

  it("start_run rejects more than 50 scenarios", async () => {
    const ids = Array.from({ length: 51 }, () => IDS.scenario);
    const result = await harness.call("start_run", { target_id: IDS.target, scenario_ids: ids });
    expect(result.body.error.code).toBe("invalid_arguments");
  });

  it("get_run returns verdicts and the failing steps of scenarios that did not pass", async () => {
    const result = await harness.call("get_run", { run_id: IDS.run });
    expect(result.body.run).toMatchObject({ id: IDS.run, status: "completed", terminal: true, subset: false });
    expect(result.body.stats.invariants_needing_attention).toHaveLength(1);
    expect(result.body.scenarios).toHaveLength(2);
    const failing = result.body.scenarios[0];
    expect(failing.verdict.status).toBe("fail");
    expect(failing.failing_steps).toEqual([
      {
        step_id: IDS.step,
        index: 0,
        attempt: 0,
        label: "createIssue",
        adapter: "graphql",
        tier0_failure_count: 1,
        verdict: expect.objectContaining({ status: "fail" }),
      },
    ]);
    expect(result.body.scenarios[1].failing_steps).toBeNull();
    expect(result.body.has_more_scenarios).toBe(false);
  });

  it("get_run marks a subset run", async () => {
    mswServer.use(
      http.get(`${API}/runs/:runId`, () =>
        HttpResponse.json(run("completed", { config_snapshot: runConfigSnapshot({ scenario_ids: [IDS.scenario] }) })),
      ),
    );
    const result = await harness.call("get_run", { run_id: IDS.run });
    expect(result.body.run.subset).toBe(true);
  });

  it("get_run tolerates a run without stats", async () => {
    mswServer.use(
      http.get(`${API}/runs/:runId/stats`, () => HttpResponse.json(errorBody("not_found", "none"), { status: 404 })),
    );
    const result = await harness.call("get_run", { run_id: IDS.run });
    expect(result.isError).toBe(false);
    expect(result.body.stats).toBeNull();
  });

  it("run_diff summarises the comparison", async () => {
    const result = await harness.call("run_diff", { run_id: IDS.run, against: IDS.plan });
    expect(result.body.new_failures).toEqual([IDS.scenario]);
    expect(result.body.items[0]).toMatchObject({ category: "new_failure", before: { status: "pass" }, after: { status: "fail" } });
    expect(requestsTo("GET", `/runs/${IDS.run}/diff`)[0]?.search).toContain(`against=${IDS.plan}`);
  });

  it("cancel_run returns the canceling run", async () => {
    const result = await harness.call("cancel_run", { run_id: IDS.run });
    expect(result.body.run.status).toBe("canceling");
    expect(result.body.run.terminal).toBe(false);
  });

  it("get_run returns the totals when stats are present", async () => {
    const result = await harness.call("get_run", { run_id: IDS.run });
    expect(result.body.stats.pass_hat_k).toBe(runStats.pass_hat_k);
    expect(result.body.stats.cost_usd.total).toBe(0.2);
  });
});

describe("get_step", () => {
  it("returns the step with absolute artifact urls and nothing cut", async () => {
    const result = await harness.call("get_step", { step_id: IDS.step });
    expect(result.body.verdict.status).toBe("fail");
    expect(result.body.request).toEqual({ kind: "graphql", query: "mutation { createIssue }" });
    expect(result.body.truncated).toMatchObject({ request: false, response: false, evidence: false });
    expect(result.body.artifacts[0].url).toBe(`${BASE_URL}/api/v1/artifacts/signed-token-1`);
  });

  it("cuts request, response and evidence at 20 KB and flags each", async () => {
    const huge = { body: "y".repeat(50_000) };
    mswServer.use(
      http.get(`${API}/steps/:stepId`, () =>
        HttpResponse.json(step({ request: huge, response: huge, evidence: huge, ask: "a".repeat(30_000) })),
      ),
    );
    const result = await harness.call("get_step", { step_id: IDS.step });
    expect(result.body.truncated).toMatchObject({ request: true, response: true, evidence: true, ask: true });
    expect(typeof result.body.request).toBe("string");
    expect(Buffer.byteLength(result.body.request)).toBeLessThanOrEqual(20_000);
    expect(Buffer.byteLength(result.body.response)).toBeLessThanOrEqual(20_000);
    expect(Buffer.byteLength(result.body.evidence)).toBeLessThanOrEqual(20_000);
    expect(Buffer.byteLength(result.body.ask)).toBeLessThanOrEqual(20_000);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(100_000);
  });

  it("keeps a payload that is exactly at the cut", async () => {
    const exact = "z".repeat(20_000);
    mswServer.use(http.get(`${API}/steps/:stepId`, () => HttpResponse.json(step({ answer: exact }))));
    const result = await harness.call("get_step", { step_id: IDS.step });
    expect(result.body.truncated.answer).toBe(false);
    expect(result.body.answer).toBe(exact);
  });

  it("falls back to a size note when the whole result is far too large", async () => {
    mswServer.use(
      http.get(`${API}/steps/:stepId`, () =>
        HttpResponse.json(
          step({
            probes: Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, note: "n".repeat(5000) })),
            cards: [],
            gold_points: Array.from({ length: 30 }, (_, index) => ({ id: `g${index}`, note: "g".repeat(5000) })),
          }),
        ),
      ),
    );
    const result = await harness.call("get_step", { step_id: IDS.step });
    expect(result.body.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(60_000);
  });
});

describe("finding tools", () => {
  it("list_findings sends single and multiple filters", async () => {
    const result = await harness.call("list_findings", {
      target_id: IDS.target,
      status: "new",
      severity: ["high", "critical"],
      limit: 5,
    });
    expect(result.body.findings[0]).toMatchObject({ id: IDS.finding, status: "new", severity: "high" });
    const search = requestsTo("GET", "/findings")[0]?.search ?? "";
    expect(search).toContain("status=new");
    expect(search).toContain("severity=high");
    expect(search).toContain("severity=critical");
    expect(search).toContain("limit=5");
  });

  it("get_finding returns the structured explanation and the repro", async () => {
    const result = await harness.call("get_finding", { finding_id: IDS.finding });
    expect(result.body.finding.expected).toEqual({ status: 200 });
    expect(result.body.latest_explanation.structured.opinion).toBe("app_bug");
    expect(result.body.repro.transcript).toHaveLength(3);
    expect(result.body.repro.transcript_truncated).toBe(false);
    expect(result.body.repro.transcript[0].text_cut).toBe(true);
  });

  it("get_finding cuts the transcript at 40 entries", async () => {
    mswServer.use(http.get(`${API}/findings/:findingId/repro`, () => HttpResponse.json(repro(60))));
    const result = await harness.call("get_finding", { finding_id: IDS.finding });
    expect(result.body.repro.transcript).toHaveLength(40);
    expect(result.body.repro.transcript_total).toBe(60);
    expect(result.body.repro.transcript_truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(60_000);
  });

  it("get_finding returns a null repro when there is none", async () => {
    mswServer.use(
      http.get(`${API}/findings/:findingId/repro`, () => HttpResponse.json(errorBody("not_found", "none"), { status: 404 })),
    );
    const result = await harness.call("get_finding", { finding_id: IDS.finding });
    expect(result.body.repro).toBeNull();
  });

  it("add_explanation posts text and the structured object with an idempotency key", async () => {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.post(`${API}/findings/:findingId/explanations`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(explanationCreated, { status: 201 });
      }),
    );
    const structured = {
      opinion: "app_bug",
      root_cause: "Missing null check in the resolver",
      files: [{ path: "src/resolvers/issue.ts", lines: "12-40" }],
      commit: "abc1234",
      confidence: "high",
    };
    const result = await harness.call("add_explanation", {
      finding_id: IDS.finding,
      text: "The resolver does not check the room id.",
      structured,
    });
    expect(received).toEqual({ text: "The resolver does not check the room id.", structured });
    expect(result.body.explanation).toMatchObject({ id: IDS.explanation, has_structured: true });
    expect(requestsTo("POST", `/findings/${IDS.finding}/explanations`)[0]?.headers["idempotency-key"]).toBeTruthy();
  });

  it.each([
    ["an absolute path", { path: "/etc/passwd" }],
    ["a windows drive path", { path: "C:\\repo\\a.ts" }],
    ["a parent path", { path: "../secret.ts" }],
    ["a bad line range", { path: "a.ts", lines: "twelve" }],
  ])("add_explanation rejects %s before any request", async (_name, file) => {
    const result = await harness.call("add_explanation", {
      finding_id: IDS.finding,
      text: "text",
      structured: { opinion: "unknown", root_cause: "x", files: [file], confidence: "low" },
    });
    expect(result.isError).toBe(true);
    expect(result.body.error.code).toBe("invalid_arguments");
    expect(requestsTo("POST", `/findings/${IDS.finding}/explanations`)).toHaveLength(0);
  });

  it("move_finding patches the status", async () => {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.patch(`${API}/findings/:findingId`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...(finding as object), status: "known_gap", known_gap_reason: "legacy" });
      }),
    );
    const result = await harness.call("move_finding", {
      finding_id: IDS.finding,
      status: "known_gap",
      known_gap_reason: "legacy",
    });
    expect(received).toEqual({ status: "known_gap", known_gap_reason: "legacy" });
    expect(result.body.finding).toMatchObject({ status: "known_gap", known_gap_reason: "legacy" });
  });

  it("move_finding cannot set resolved", async () => {
    const result = await harness.call("move_finding", { finding_id: IDS.finding, status: "resolved" });
    expect(result.body.error.code).toBe("invalid_arguments");
  });
});

describe("ApiError mapping", () => {
  const tools: Array<[string, Record<string, unknown>]> = [
    ["whoami", {}],
    ["list_targets", {}],
    ["get_target", { target_id: IDS.target }],
    ["issue_prompt", { target_id: IDS.target, template: "discovery" }],
    ["validate_bundle", { path: "BUNDLE" }],
    ["upload_bundle", { path: "BUNDLE" }],
    ["get_bundle", { bundle_id: IDS.bundle }],
    ["get_environment", { target_id: IDS.target }],
    ["set_environment", { target_id: IDS.target, values: { A_B: "value" } }],
    ["run_health_checks", { target_id: IDS.target }],
    ["start_run", { plan_id: IDS.plan }],
    ["wait_run", { run_id: IDS.run }],
    ["get_run", { run_id: IDS.run }],
    ["get_step", { step_id: IDS.step }],
    ["run_diff", { run_id: IDS.run }],
    ["cancel_run", { run_id: IDS.run }],
    ["list_findings", { target_id: IDS.target }],
    ["get_finding", { finding_id: IDS.finding }],
    ["add_explanation", { finding_id: IDS.finding, text: "t" }],
    ["move_finding", { finding_id: IDS.finding, status: "triaged" }],
    ["get_proposal", { target_id: IDS.target }],
    ["put_proposal", { path: "BUNDLE", target_id: IDS.target }],
    ["update_proposal_item", { item_id: IDS.scenario, status: "selected" }],
    ["plan_from_proposal", { target_id: IDS.target }],
    ["get_coverage", { target_id: IDS.target }],
    ["validate_scenario", { yaml: "id: a", target_id: IDS.target }],
    ["list_scenarios", { target_id: IDS.target }],
  ];

  it("covers every tool", () => {
    expect(tools).toHaveLength(27);
  });

  it.each(tools)("%s maps a 409 to an error result", async (name, args) => {
    mswServer.use(
      http.all(`${API}/*`, () =>
        HttpResponse.json(errorBody("conflict_fixture", "Nope", [{ code: "why", message: "because", loc: ["x"] }]), {
          status: 409,
        }),
      ),
    );
    const resolved = JSON.parse(JSON.stringify(args).replace("BUNDLE", bundleRoot.replace(/\\/g, "\\\\")));
    const result = await harness.call(name, resolved);
    expect(result.isError).toBe(true);
    expect(result.body.error).toEqual({
      code: "conflict_fixture",
      status: 409,
      message: "Nope",
      requestId: "req-fixture-1",
      details: [{ code: "why", message: "because", loc: ["x"] }],
    });
  });

  it("a dead token surfaces the api code", async () => {
    mswServer.use(
      http.all(`${API}/*`, () => HttpResponse.json(errorBody("token_expired", "Token expired"), { status: 401 })),
    );
    const result = await harness.call("whoami");
    expect(result.body.error).toMatchObject({ code: "token_expired", status: 401 });
  });
});

describe("write tools carry an idempotency key", () => {
  it("every idempotent post has one", async () => {
    await harness.call("issue_prompt", { target_id: IDS.target, template: "discovery" });
    await harness.call("upload_bundle", { path: bundleRoot });
    await harness.call("start_run", { plan_id: IDS.plan });
    await harness.call("add_explanation", { finding_id: IDS.finding, text: "t" });
    const posts = seen.filter((entry) => entry.method === "POST");
    expect(posts).toHaveLength(4);
    for (const request of posts) {
      expect(request.headers["idempotency-key"], request.path).toMatch(/^[\x21-\x7E]{8,128}$/);
      expect(request.headers["x-request-id"], request.path).toBeTruthy();
    }
    const keys = posts.map((request) => request.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(4);
  });
});

describe("result hygiene", () => {
  it("never contains the personal token even when the api echoes it", async () => {
    mswServer.use(
      http.get(`${API}/users/me`, () =>
        HttpResponse.json({ id: IDS.user, email: `x@y.z ${TOKEN}`, name: `Bearer ${TOKEN}`, role: "member" }),
      ),
    );
    const result = await harness.call("whoami");
    expect(result.text).not.toContain(TOKEN);
    expect(result.text).not.toContain(TOKEN.slice(0, 20));
  });
});
