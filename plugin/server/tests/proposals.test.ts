import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  BASE_URL,
  IDS,
  TARGET_TOKEN,
  TOKEN,
  coverageCell,
  coverageMap,
  errorBody,
  planFixture,
  promptIssue,
  proposal,
  proposalDoc,
  proposalDocItem,
  proposalItem,
  proposalWithItems,
  scenarioSummary,
  uuidFor,
} from "./fixtures";
import { createHarness, mswServer, requestsTo, resetSeen, seen, type Harness } from "./harness";

const API = `${BASE_URL}/api/v1`;

let harness: Harness;
let root: string;

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());

beforeEach(async () => {
  resetSeen();
  harness = createHarness();
  root = await mkdtemp(join(tmpdir(), "tessa-proposals-"));
  await mkdir(join(root, "tessa"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeProposal(document: unknown) {
  const text = typeof document === "string" ? document : stringify(document);
  await writeFile(join(root, "tessa", "proposal.yaml"), text);
  return text;
}

async function putBody() {
  let received: Record<string, unknown> = {};
  mswServer.use(
    http.put(`${API}/targets/:targetId/proposal`, async ({ request }) => {
      received = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ ...proposal, source: "put" });
    }),
  );
  return () => received;
}

describe("get_proposal", () => {
  it("answers a null proposal for a 404 and not an error", async () => {
    const result = await harness.call("get_proposal", { target_id: IDS.target });
    expect(result.isError).toBe(false);
    expect(result.body).toEqual({ proposal: null });
  });

  it("returns the items with status, risk, cell counts, stale and source", async () => {
    mswServer.use(
      http.get(`${API}/targets/:targetId/proposal`, () =>
        HttpResponse.json({ ...proposal, stale: true, source: "put" }),
      ),
    );
    const result = await harness.call("get_proposal", { target_id: IDS.target });
    expect(result.isError).toBe(false);
    const body = result.body.proposal;
    expect(body).toMatchObject({
      id: proposal.id,
      stale: true,
      source: "put",
      commit_sha: "abc1234",
      branch: "main",
      item_count: 3,
      status_counts: { proposed: 2, selected: 1 },
      risk_counts: { high: 1, medium: 2 },
      items_matching: 3,
      items_truncated: false,
    });
    expect(body.items[0]).toMatchObject({
      id: proposal.items[0]?.id,
      key: "billing.refund.partial",
      title: "Item 0",
      area: "Billing",
      kind: "api",
      risk: "high",
      status: "proposed",
      cell_count: 2,
      scenario_count: 0,
      reasons: [{ code: "money_path", note: "refunds.py moves money" }],
      needs: ["seed"],
      estimate: { scenarios: 4, minutes: 6 },
    });
  });

  it("keeps the item keys readable although key is a secret-looking name", async () => {
    mswServer.use(http.get(`${API}/targets/:targetId/proposal`, () => HttpResponse.json(proposal)));
    const result = await harness.call("get_proposal", { target_id: IDS.target });
    expect(result.text).toContain("billing.refund.partial");
    expect(result.text).toContain("auth.login.lockout");
    expect(result.text).not.toContain("[redacted]");
  });

  it("filters by status and area", async () => {
    mswServer.use(http.get(`${API}/targets/:targetId/proposal`, () => HttpResponse.json(proposal)));
    const selected = await harness.call("get_proposal", { target_id: IDS.target, status: "selected" });
    expect(selected.body.proposal.items.map((item: { key: string }) => item.key)).toEqual(["auth.login.lockout"]);
    expect(selected.body.proposal.items_matching).toBe(1);
    expect(selected.body.proposal.item_count).toBe(3);
    const area = await harness.call("get_proposal", { target_id: IDS.target, area: "Billing", status: ["proposed"] });
    expect(area.body.proposal.items).toHaveLength(2);
  });

  it("returns only identifying fields with keys_only and stays under the size limit for 200 items", async () => {
    mswServer.use(
      http.get(`${API}/targets/:targetId/proposal`, () => HttpResponse.json(proposalWithItems(200))),
    );
    const compact = await harness.call("get_proposal", { target_id: IDS.target, keys_only: true });
    expect(compact.body.proposal.items).toHaveLength(200);
    expect(compact.body.proposal.items_truncated).toBe(false);
    expect(Object.keys(compact.body.proposal.items[0]).sort()).toEqual(
      ["area", "cell_count", "id", "key", "risk", "status", "title"].sort(),
    );
    expect(Buffer.byteLength(compact.text)).toBeLessThan(60_000);

    const full = await harness.call("get_proposal", { target_id: IDS.target });
    expect(full.body.proposal.items_truncated).toBe(true);
    expect(full.body.proposal.items.length).toBeLessThan(200);
    expect(full.body.proposal.item_count).toBe(200);
    expect(Buffer.byteLength(full.text)).toBeLessThan(60_000);
  });

  it("never leaks the token that an item echoes", async () => {
    mswServer.use(
      http.get(`${API}/targets/:targetId/proposal`, () =>
        HttpResponse.json({
          ...proposal,
          items: [proposalItem(0, { title: `Bearer ${TOKEN}`, evidence: `used ${TOKEN}`, key: `k.${TOKEN}` })],
        }),
      ),
    );
    const result = await harness.call("get_proposal", { target_id: IDS.target });
    expect(result.text).not.toContain(TOKEN);
    expect(result.text).not.toContain(TOKEN.slice(0, 20));
  });
});

describe("update_proposal_item", () => {
  it("patches the status and the note and returns the item", async () => {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.patch(`${API}/proposal-items/:itemId`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(proposalItem(1, { status: "declined", note: "not now" }));
      }),
    );
    const result = await harness.call("update_proposal_item", {
      item_id: IDS.scenario,
      status: "declined",
      note: "not now",
    });
    expect(result.isError).toBe(false);
    expect(received).toEqual({ status: "declined", note: "not now" });
    expect(result.body.item).toMatchObject({ status: "declined", note: "not now", key: "auth.login.lockout" });
    expect(requestsTo("PATCH", `/proposal-items/${IDS.scenario}`)).toHaveLength(1);
  });

  it("refuses authored and covered before any request", async () => {
    for (const status of ["authored", "covered", "bogus"]) {
      const result = await harness.call("update_proposal_item", { item_id: IDS.scenario, status });
      expect(result.isError).toBe(true);
      expect(result.body.error.code).toBe("invalid_arguments");
    }
    expect(seen.filter((entry) => entry.method === "PATCH")).toHaveLength(0);
  });

  it("refuses a note above 300 characters", async () => {
    const result = await harness.call("update_proposal_item", {
      item_id: IDS.scenario,
      status: "selected",
      note: "x".repeat(301),
    });
    expect(result.body.error.code).toBe("invalid_arguments");
  });

  it("maps a conflict to an error", async () => {
    mswServer.use(
      http.patch(`${API}/proposal-items/:itemId`, () =>
        HttpResponse.json(errorBody("conflict", "The item belongs to an older proposal"), { status: 409 }),
      ),
    );
    const result = await harness.call("update_proposal_item", { item_id: IDS.scenario, status: "selected" });
    expect(result.body.error).toMatchObject({ code: "conflict", status: 409 });
  });
});

describe("plan_from_proposal", () => {
  it("posts the selection with an idempotency key and returns the plan", async () => {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.post(`${API}/targets/:targetId/proposal/plan`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(planFixture, { status: 201 });
      }),
    );
    const result = await harness.call("plan_from_proposal", {
      target_id: IDS.target,
      name: "From proposal",
      item_ids: [IDS.scenario],
    });
    expect(result.isError).toBe(false);
    expect(received).toEqual({ name: "From proposal", item_ids: [IDS.scenario] });
    expect(result.body.plan).toMatchObject({ id: IDS.plan, saved: true, cells_total: 2, name: "From proposal" });
    const posts = requestsTo("POST", `/targets/${IDS.target}/proposal/plan`);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.headers["idempotency-key"]).toMatch(/^[\x21-\x7E]{8,128}$/);
  });

  it("sends nulls when nothing is named and plans every selected item", async () => {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.post(`${API}/targets/:targetId/proposal/plan`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(planFixture, { status: 201 });
      }),
    );
    await harness.call("plan_from_proposal", { target_id: IDS.target });
    await harness.call("plan_from_proposal", { target_id: IDS.target });
    expect(received).toEqual({ name: null, item_ids: null });
    const keys = requestsTo("POST", `/targets/${IDS.target}/proposal/plan`).map(
      (entry) => entry.headers["idempotency-key"],
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("surfaces nothing_selected", async () => {
    mswServer.use(
      http.post(`${API}/targets/:targetId/proposal/plan`, () =>
        HttpResponse.json(
          errorBody("validation_failed", "No item is selected", [
            { code: "nothing_selected", message: "Tick at least one item", loc: [] },
          ]),
          { status: 422 },
        ),
      ),
    );
    const result = await harness.call("plan_from_proposal", { target_id: IDS.target });
    expect(result.body.error.status).toBe(422);
    expect(result.body.error.details[0].code).toBe("nothing_selected");
  });
});

describe("put_proposal", () => {
  it("validates locally, sends the file text unchanged and returns the proposal", async () => {
    const text = await writeProposal(proposalDoc(2));
    const received = await putBody();
    const result = await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(result.isError).toBe(false);
    expect(received()).toEqual({ yaml: text });
    expect(result.body.local_validation).toBe("passed");
    expect(result.body.proposal).toMatchObject({ source: "put", item_count: 3 });
    expect(result.body.warnings).toEqual([]);
    expect(requestsTo("PUT", `/targets/${IDS.target}/proposal`)).toHaveLength(1);
  });

  it("uses the target of the session when none is passed and accepts the tessa folder or the file", async () => {
    await writeProposal(proposalDoc(1));
    harness.session.state.targetId = IDS.target;
    harness.session.state.targetToken = TARGET_TOKEN;
    for (const path of [root, join(root, "tessa"), join(root, "tessa", "proposal.yaml")]) {
      const result = await harness.call("put_proposal", { path });
      expect(result.isError, path).toBe(false);
    }
    expect(requestsTo("PUT", `/targets/${IDS.target}/proposal`)).toHaveLength(3);
  });

  it("fetches the schema once per server", async () => {
    await writeProposal(proposalDoc(1));
    await harness.call("put_proposal", { path: root, target_id: IDS.target });
    await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(requestsTo("GET", "/proposal.v1.json")).toHaveLength(0);
    expect(seen.filter((entry) => entry.path === "/schemas/proposal.v1.json")).toHaveLength(1);
  });

  type Case = {
    name: string;
    build: () => unknown;
    expectIn: string;
    pointer?: string;
  };

  const invalidCases: Case[] = [
    {
      name: "an unknown key on an item",
      build: () => proposalDoc(1, { items: [proposalDocItem(0, { colour: "red" })] }),
      expectIn: "unknown key colour",
      pointer: "/items/0/colour",
    },
    {
      name: "an unknown top-level key",
      build: () => proposalDoc(1, { notes: "x" }),
      expectIn: "unknown key notes",
      pointer: "/notes",
    },
    {
      name: "201 items",
      build: () => proposalDoc(201),
      expectIn: "at most 200 entries, has 201",
      pointer: "/items",
    },
    {
      name: "no items",
      build: () => proposalDoc(0),
      expectIn: "at least 1 entries",
      pointer: "/items",
    },
    {
      name: "a missing required field",
      build: () => {
        const item = proposalDocItem(0) as Record<string, unknown>;
        delete item.risk;
        return proposalDoc(1, { items: [item] });
      },
      expectIn: "missing the required key risk",
      pointer: "/items/0",
    },
    {
      name: "a bad enum value",
      build: () => proposalDoc(1, { items: [proposalDocItem(0, { kind: "gui" })] }),
      expectIn: "must be one of",
      pointer: "/items/0/kind",
    },
    {
      name: "a bad reason code",
      build: () => proposalDoc(1, { items: [proposalDocItem(0, { reasons: [{ code: "vibes" }] })] }),
      expectIn: "must be one of",
      pointer: "/items/0/reasons/0/code",
    },
    {
      name: "a key that is not a slug",
      build: () => proposalDoc(1, { items: [proposalDocItem(0, { key: "Bad Key" })] }),
      expectIn: "must match",
      pointer: "/items/0/key",
    },
    {
      name: "a title above 120 characters",
      build: () => proposalDoc(1, { items: [proposalDocItem(0, { title: "t".repeat(121) })] }),
      expectIn: "at most 120 characters",
      pointer: "/items/0/title",
    },
    {
      name: "an estimate out of range",
      build: () => proposalDoc(1, { items: [proposalDocItem(0, { estimate: { scenarios: 51, minutes: 1 } })] }),
      expectIn: "at most 50",
      pointer: "/items/0/estimate/scenarios",
    },
    {
      name: "a date without an offset",
      build: () => proposalDoc(1, { generated_at: "2026-10-08 09:30" }),
      expectIn: "date-time",
      pointer: "/generated_at",
    },
    {
      name: "a target token of the wrong shape",
      build: () => proposalDoc(1, { target_token: "tgt_short" }),
      expectIn: "must match",
      pointer: "/target_token",
    },
    {
      name: "a source commit that is not hex",
      build: () => proposalDoc(1, { source: { commit: "HEAD" } }),
      expectIn: "must match",
      pointer: "/source/commit",
    },
    {
      name: "a repeated item key",
      build: () => proposalDoc(1, { items: [proposalDocItem(0), proposalDocItem(0)] }),
      expectIn: "repeats the key",
      pointer: "/items/1/key",
    },
  ];

  it.each(invalidCases)("refuses $name before any request", async ({ build, expectIn, pointer }) => {
    await writeProposal(build());
    const result = await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(result.isError).toBe(true);
    expect(result.body.error.code).toBe("proposal_invalid_local");
    expect(result.body.error.status).toBe(0);
    const messages = result.body.error.details.map((detail: { message: string }) => detail.message);
    expect(messages.some((message: string) => message.includes(expectIn)), messages.join("\n")).toBe(true);
    if (pointer !== undefined) {
      expect(result.body.error.details.some((detail: { message: string }) => detail.message.includes(pointer))).toBe(
        true,
      );
    }
    expect(seen.filter((entry) => entry.method === "PUT")).toHaveLength(0);
  });

  it("puts a line number in the message of a problem", async () => {
    await writeProposal(
      [
        `schema: ${BASE_URL}/schemas/proposal.v1.json`,
        `target_token: ${TARGET_TOKEN}`,
        "items:",
        "  - key: billing.refund.partial",
        "    title: Refund",
        "    area: Billing",
        "    feature_ids: [billing.refund]",
        "    kind: gui",
        "    risk: high",
        "    reasons:",
        "      - code: money_path",
        "    depth: standard",
        "    confidence: medium",
        "",
      ].join("\n"),
    );
    const result = await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(result.body.error.details[0].message).toContain("line 8:");
    expect(result.body.error.details[0].loc).toEqual(["items", 0, "kind"]);
  });

  it("reports malformed YAML with its line", async () => {
    await writeProposal("schema: [unclosed\nitems:\n  - a: b\n  c");
    const result = await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(result.body.error.code).toBe("proposal_yaml_invalid");
    expect(result.body.error.details.length).toBeGreaterThan(0);
    expect(seen.filter((entry) => entry.method === "PUT")).toHaveLength(0);
  });

  it("reports a missing file", async () => {
    const result = await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(result.body.error.code).toBe("proposal_not_found");
  });

  it("refuses a file above 256 KiB", async () => {
    await writeProposal(`${"#".repeat(300_000)}\n`);
    const result = await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(result.body.error.code).toBe("proposal_too_large");
  });

  it("needs a target", async () => {
    await writeProposal(proposalDoc(1));
    const result = await harness.call("put_proposal", { path: root });
    expect(result.body.error.code).toBe("target_required");
  });

  it("refuses a proposal of another target than the selected one", async () => {
    await writeProposal(proposalDoc(1, { target_token: "tgt_otherfixture22222222a" }));
    harness.session.state.targetId = IDS.target;
    harness.session.state.targetToken = TARGET_TOKEN;
    const result = await harness.call("put_proposal", { path: root });
    expect(result.body.error.code).toBe("target_mismatch");
    expect(seen.filter((entry) => entry.method === "PUT")).toHaveLength(0);
  });

  it("falls back to the server check when the schema is not published", async () => {
    await writeProposal(proposalDoc(1));
    mswServer.use(
      http.get(`${BASE_URL}/schemas/proposal.v1.json`, () =>
        HttpResponse.json(errorBody("not_found", "No published schema"), { status: 404 }),
      ),
    );
    const result = await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(result.isError).toBe(false);
    expect(result.body.local_validation).toBe("skipped_schema_not_published");
  });

  it("maps a server rejection with its pointers", async () => {
    await writeProposal(proposalDoc(1));
    mswServer.use(
      http.put(`${API}/targets/:targetId/proposal`, () =>
        HttpResponse.json(
          errorBody("proposal_invalid", "The proposal is invalid", [
            { code: "unknown_area", message: "line 6: area Billing is not in the catalog", loc: ["items", 0, "area"] },
          ]),
          { status: 422 },
        ),
      ),
    );
    const result = await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(result.body.error).toMatchObject({ code: "proposal_invalid", status: 422 });
    expect(result.body.error.details[0].loc).toEqual(["items", 0, "area"]);
  });

  it("derives warnings for a lowered confidence and for items that map to no cell", async () => {
    await writeProposal(proposalDoc(2));
    mswServer.use(
      http.put(`${API}/targets/:targetId/proposal`, () =>
        HttpResponse.json({
          ...proposal,
          source: "put",
          items: [
            proposalItem(0, { key: "billing.refund.partial", confidence: "low" }),
            proposalItem(1, { key: "auth.login.lockout", cell_ids: [] }),
          ],
        }),
      ),
    );
    const result = await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(result.body.warnings).toEqual([
      expect.objectContaining({ key: "billing.refund.partial", code: "confidence_lowered" }),
      expect.objectContaining({ key: "auth.login.lockout", code: "no_cells" }),
    ]);
  });

  it("does not carry a secret into the result", async () => {
    await writeProposal(proposalDoc(1));
    mswServer.use(
      http.put(`${API}/targets/:targetId/proposal`, () =>
        HttpResponse.json(errorBody("bundle_contains_secret", `found ${TOKEN}`), { status: 422 }),
      ),
    );
    const result = await harness.call("put_proposal", { path: root, target_id: IDS.target });
    expect(result.text).not.toContain(TOKEN);
  });
});

describe("get_coverage", () => {
  it("returns the totals and compact cells without empty fields", async () => {
    const result = await harness.call("get_coverage", { target_id: IDS.target });
    expect(result.isError).toBe(false);
    expect(result.body).toMatchObject({
      plan_id: IDS.plan,
      bundle_id: IDS.bundle,
      cells_total: 3,
      cells_returned: 3,
      truncated: false,
      next_offset: null,
      totals: { needs_author: 1, covered: 2, empty: 0, generated: 0, blocked: 0 },
    });
    expect(result.body.cells[0]).toEqual({
      id: uuidFor("3000000a", 0),
      feature_id: "feature.0",
      role: "staff",
      interface_id: "api",
      family: "feature",
      status: "needs_author",
      scenario_count: 0,
      reason: "no scenario for this role",
    });
    expect(result.body.cells[1]).not.toHaveProperty("reason");
  });

  it("forwards the status and area filters as repeated parameters", async () => {
    await harness.call("get_coverage", { target_id: IDS.target, status: ["needs_author", "blocked"], area: "Billing" });
    const request = requestsTo("GET", "/coverage")[0];
    expect(request?.search).toContain("status=needs_author");
    expect(request?.search).toContain("status=blocked");
    expect(request?.search).toContain("area=Billing");
    expect(request?.search).toContain(`target_id=${IDS.target}`);
  });

  it("cuts at 500 cells, says so and pages with the offset", async () => {
    const big = coverageMap(1200);
    big.cells = big.cells.map((cell) => ({ ...cell, reason: null }));
    mswServer.use(http.get(`${API}/coverage`, () => HttpResponse.json(big)));
    const first = await harness.call("get_coverage", { target_id: IDS.target });
    expect(first.body.cells_total).toBe(1200);
    expect(first.body.truncated).toBe(true);
    expect(first.body.cells_returned).toBeLessThanOrEqual(500);
    expect(first.body.cells).toHaveLength(first.body.cells_returned);
    expect(first.body.next_offset).toBe(first.body.cells_returned);
    expect(Buffer.byteLength(first.text)).toBeLessThan(60_000);

    const second = await harness.call("get_coverage", { target_id: IDS.target, offset: first.body.next_offset });
    expect(second.body.cells[0].id).toBe(uuidFor("3000000a", first.body.next_offset));
    expect(second.body.offset).toBe(first.body.next_offset);
  });

  it("never returns more than 500 cells even when they are tiny", async () => {
    const big = coverageMap(600);
    big.cells = big.cells.map((cell, index) => ({
      ...cell,
      id: uuidFor("3000000a", index),
      feature_id: "f",
      role: "r",
      interface_id: "i",
      family: "f",
    }));
    mswServer.use(http.get(`${API}/coverage`, () => HttpResponse.json(big)));
    const result = await harness.call("get_coverage", { target_id: IDS.target });
    expect(result.body.cells_returned).toBeLessThanOrEqual(500);
    expect(result.body.truncated).toBe(true);
    expect(result.body.cells_total).toBe(600);
  });

  it("keeps the proposal markers and cuts a long reason", async () => {
    const map = coverageMap(1);
    map.cells = [
      coverageCell(0, { proposal_item_ids: [IDS.scenario], reason: "r".repeat(1000), skip_reason: "no_oracle" }),
    ];
    mswServer.use(http.get(`${API}/coverage`, () => HttpResponse.json(map)));
    const result = await harness.call("get_coverage", { target_id: IDS.target });
    expect(result.body.cells[0].proposal_item_ids).toEqual([IDS.scenario]);
    expect(result.body.cells[0].skip_reason).toBe("no_oracle");
    expect(result.body.cells[0].reason.length).toBe(160);
  });

  it("rejects an unknown status before any request", async () => {
    const result = await harness.call("get_coverage", { target_id: IDS.target, status: "done" });
    expect(result.body.error.code).toBe("invalid_arguments");
    expect(requestsTo("GET", "/coverage")).toHaveLength(0);
  });
});

describe("validate_scenario", () => {
  it("posts the yaml with the selected target and returns the issues", async () => {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.post(`${API}/scenarios/validate`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          valid: false,
          errors: [{ code: "unknown_role", pointer: "/role", line: 7, column: 7, message: "role admin is not in the manifest" }],
          warnings: [],
        });
      }),
    );
    harness.session.state.targetId = IDS.target;
    const result = await harness.call("validate_scenario", { yaml: "id: a\n" });
    expect(received).toEqual({ target_id: IDS.target, yaml: "id: a\n" });
    expect(result.body).toMatchObject({ valid: false, errors_total: 1, truncated: false });
    expect(result.body.errors[0]).toMatchObject({ code: "unknown_role", line: 7 });
  });

  it("needs a target", async () => {
    const result = await harness.call("validate_scenario", { yaml: "id: a\n" });
    expect(result.body.error.code).toBe("target_required");
    expect(requestsTo("POST", "/scenarios/validate")).toHaveLength(0);
  });

  it("cuts a long list of issues", async () => {
    const issues = Array.from({ length: 80 }, (_, index) => ({
      code: "x",
      pointer: `/steps/${index}`,
      line: index + 1,
      column: 1,
      message: "bad",
    }));
    mswServer.use(
      http.post(`${API}/scenarios/validate`, () => HttpResponse.json({ valid: false, errors: issues, warnings: [] })),
    );
    const result = await harness.call("validate_scenario", { yaml: "id: a\n", target_id: IDS.target });
    expect(result.body.errors).toHaveLength(50);
    expect(result.body.errors_total).toBe(80);
    expect(result.body.truncated).toBe(true);
  });
});

describe("list_scenarios", () => {
  it("lists compact scenarios and forwards the filters", async () => {
    const result = await harness.call("list_scenarios", { target_id: IDS.target, status: ["in_review", "invalid"], limit: 20 });
    expect(result.body.scenarios).toHaveLength(2);
    expect(result.body.scenarios[0]).toMatchObject({
      id: uuidFor("4000000a", 0),
      status: "in_review",
      origin: "authored",
      valid: true,
      error_count: 0,
      first_error: null,
    });
    expect(result.body.has_more).toBe(false);
    const request = requestsTo("GET", "/scenarios")[0];
    expect(request?.search).toContain("status=in_review");
    expect(request?.search).toContain("status=invalid");
    expect(request?.search).toContain("limit=20");
    expect(request?.search).toContain(`target_id=${IDS.target}`);
  });

  it("names the first validation error of an invalid scenario", async () => {
    mswServer.use(
      http.get(`${API}/scenarios`, () =>
        HttpResponse.json({
          items: [
            scenarioSummary(0, {
              status: "invalid",
              validation: {
                valid: false,
                errors: [{ code: "x", pointer: "/a", line: 1, column: 1, message: "unknown oracle" }],
                warnings: [],
              },
            }),
          ],
          next_cursor: "abc",
          total: null,
        }),
      ),
    );
    const result = await harness.call("list_scenarios", { target_id: IDS.target });
    expect(result.body.scenarios[0]).toMatchObject({ valid: false, error_count: 1, first_error: "unknown oracle" });
    expect(result.body.has_more).toBe(true);
  });
});

describe("issue_prompt for propose and author", () => {
  async function issued(args: Record<string, unknown>) {
    let received: Record<string, unknown> = {};
    mswServer.use(
      http.post(`${API}/targets/:targetId/prompt-issues`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...promptIssue, template_name: args.template }, { status: 201 });
      }),
    );
    const result = await harness.call("issue_prompt", { target_id: IDS.target, ...args });
    return { result, received: () => received };
  }

  it("issues the propose template with focus and since_commit", async () => {
    const { result, received } = await issued({
      template: "propose",
      params: { focus: ["Billing", "Auth"], since_commit: "3f9c2ab" },
    });
    expect(result.isError).toBe(false);
    expect(received()).toEqual({ template_name: "propose", focus: ["Billing", "Auth"], since_commit: "3f9c2ab" });
    expect(requestsTo("POST", `/targets/${IDS.target}/prompt-issues`)[0]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("issues propose without params", async () => {
    const { received } = await issued({ template: "propose" });
    expect(received()).toEqual({ template_name: "propose" });
  });

  it("refuses a bad since_commit, more than 20 areas and unknown params", async () => {
    for (const params of [
      { since_commit: "HEAD" },
      { since_commit: "ABCDEF1" },
      { focus: Array.from({ length: 21 }, (_, index) => `a${index}`) },
      { colour: "red" },
    ]) {
      const { result } = await issued({ template: "propose", params });
      expect(result.isError, JSON.stringify(params)).toBe(true);
      expect(result.body.error.code).toBe("invalid_arguments");
    }
    expect(requestsTo("POST", `/targets/${IDS.target}/prompt-issues`)).toHaveLength(0);
  });

  it("issues author with proposal item ids", async () => {
    const { result, received } = await issued({
      template: "author",
      params: { proposal_item_ids: [IDS.scenario, IDS.step] },
    });
    expect(result.isError).toBe(false);
    expect(received()).toEqual({ template_name: "author", proposal_item_ids: [IDS.scenario, IDS.step] });
  });

  it("still issues author with cell ids", async () => {
    const { received } = await issued({ template: "author", params: { cell_ids: [IDS.scenario] } });
    expect(received()).toEqual({ template_name: "author", cell_ids: [IDS.scenario] });
  });

  it("refuses author with both lists, with neither and with more than 50 ids", async () => {
    const many = Array.from({ length: 51 }, (_, index) => uuidFor("5000000a", index));
    for (const params of [
      { cell_ids: [IDS.scenario], proposal_item_ids: [IDS.step] },
      {},
      { proposal_item_ids: many },
      { cell_ids: ["not-a-uuid"] },
    ]) {
      const { result } = await issued({ template: "author", params });
      expect(result.isError, JSON.stringify(params)).toBe(true);
      expect(result.body.error.code).toBe("invalid_arguments");
    }
    expect(requestsTo("POST", `/targets/${IDS.target}/prompt-issues`)).toHaveLength(0);
  });

  it("requires invariant ids for mutants and a bundle id for hooks", async () => {
    for (const [template, params] of [
      ["mutants", {}],
      ["mutants", { invariant_ids: [] }],
      ["hooks", {}],
      ["hooks", { bundle_id: "nope" }],
    ] as const) {
      const { result } = await issued({ template, params });
      expect(result.body.error?.code, `${template} ${JSON.stringify(params)}`).toBe("invalid_arguments");
    }
    expect(requestsTo("POST", `/targets/${IDS.target}/prompt-issues`)).toHaveLength(0);
    const mutants = await issued({ template: "mutants", params: { invariant_ids: ["tenant_isolation"] } });
    expect(mutants.received()).toEqual({ template_name: "mutants", invariant_ids: ["tenant_isolation"] });
    const hooks = await issued({ template: "hooks", params: { bundle_id: IDS.bundle } });
    expect(hooks.received()).toEqual({ template_name: "hooks", bundle_id: IDS.bundle });
  });

  it("maps the 422 of an unknown area", async () => {
    mswServer.use(
      http.post(`${API}/targets/:targetId/prompt-issues`, () =>
        HttpResponse.json(errorBody("unknown_area", "No area Billng"), { status: 422 }),
      ),
    );
    const result = await harness.call("issue_prompt", {
      target_id: IDS.target,
      template: "propose",
      params: { focus: ["Billng"] },
    });
    expect(result.body.error).toMatchObject({ code: "unknown_area", status: 422 });
  });
});

describe("session reattach", () => {
  it("accepts a 200 for an open session as well as a 201 for a new one", async () => {
    mswServer.use(
      http.post(`${API}/agent-sessions`, async () => {
        const { agentSession } = await import("./fixtures");
        return HttpResponse.json(agentSession, { status: 200 });
      }),
    );
    await harness.session.start();
    expect(harness.session.state.id).toBe(IDS.agentSession);
  });
});
