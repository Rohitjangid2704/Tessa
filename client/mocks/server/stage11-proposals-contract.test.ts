import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Catalog } from "@/features/catalog/types";
import type {
  AuditEventPage,
  CoverageCell,
  CoverageMap,
  Plan,
  PlanPage,
  Proposal,
  ProposalItem,
} from "@/lib/api/types";
import type { RunningMockServer } from "@/mocks/server/http";
import { coverageBus } from "@/mocks/stage6/coverage-bus";
import { mockState } from "@/mocks/state";
import { toYaml } from "@/mocks/stage1/yaml";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage1Client,
  errorOf,
  STAGE_ONE_IDS,
  type Stage1Client,
} from "@/tests/utils/stage1";

type MarkedCoverageMap = Omit<CoverageMap, "cells"> & { cells: CoverageCell[] };

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
const PROPOSAL_PATH = `/api/v1/targets/${GRACIE}/proposal`;
const MISSING_ID = "0198f6f2-4c2a-7d10-9c1e-000000000000";

async function seedVariant(variant: string): Promise<void> {
  const response = await client.send("POST", "/__mock/stage11/seed", {
    variants: { proposals: variant },
  });
  expect(response.status).toBe(200);
}

async function readProposal(): Promise<Proposal> {
  const response = await client.get(PROPOSAL_PATH);
  expect(response.status).toBe(200);
  return (await response.json()) as Proposal;
}

async function patch(
  itemId: string,
  body: unknown,
  role?: "admin" | "member" | "viewer",
): Promise<Response> {
  return client.send("PATCH", `/api/v1/proposal-items/${itemId}`, body, { role });
}

function firstProposed(proposal: Proposal, area?: string): ProposalItem {
  const item = proposal.items.find(
    (candidate) =>
      candidate.status === "proposed" && (area === undefined || candidate.area === area),
  );
  expect(item).toBeDefined();
  return item as ProposalItem;
}

function proposalYaml(overrides: { items?: object[]; target_token?: string } = {}): string {
  const target = mockState.stageOne.findTarget(GRACIE);
  return toYaml({
    schema: "http://localhost:8000/schemas/proposal.v1.json",
    target_token: overrides.target_token ?? target?.targetToken ?? "",
    items: overrides.items ?? [
      {
        key: "smart-log-open-maintenance.core",
        title: "Open maintenance issues are listed",
        area: "Smart Log",
        feature_ids: ["smart_log.read.open_maintenance"],
        kind: "api",
        risk: "high",
        reasons: [{ code: "recent_change", note: "Rewritten last sprint" }],
        needs: ["seed"],
        depth: "standard",
        estimate: { scenarios: 3, minutes: 5 },
        confidence: "high",
        evidence: "src/smart_log/handlers.py",
      },
      {
        key: "smart-log-close-issue.core",
        title: "Closing an issue works",
        area: "Smart Log",
        feature_ids: ["smart_log.write.close_issue"],
        kind: "api",
        risk: "medium",
        reasons: [{ code: "complexity" }],
        depth: "smoke",
        confidence: "medium",
      },
    ],
  });
}

async function put(yaml: string, role?: "admin" | "member" | "viewer"): Promise<Response> {
  return client.send("PUT", PROPOSAL_PATH, { yaml }, { role });
}

describe("reading the proposal", () => {
  it("seeds 60 items across six areas whose features exist in the coverage rows", async () => {
    const proposal = await readProposal();
    expect(proposal.items).toHaveLength(60);
    expect(new Set(proposal.items.map((item) => item.area)).size).toBe(6);
    expect(proposal.target_id).toBe(GRACIE);
    expect(proposal.stale).toBe(false);
    expect(proposal.source).toBe("bundle");
    const coverage = (await (
      await client.get(`/api/v1/coverage?target_id=${GRACIE}`)
    ).json()) as CoverageMap;
    const known = new Set(coverage.rows.map((row) => row.feature_id));
    for (const item of proposal.items) {
      for (const featureId of item.feature_ids) {
        expect(known.has(featureId)).toBe(true);
      }
      expect(item.cell_ids.length).toBeGreaterThan(0);
    }
  });

  it("answers 404 for a target without a proposal and for the empty variant", async () => {
    const other = await client.get(`/api/v1/targets/${STAGE_ONE_IDS.billing}/proposal`);
    expect(other.status).toBe(404);
    await seedVariant("empty");
    const empty = await client.get(PROPOSAL_PATH);
    expect(empty.status).toBe(404);
    expect((await errorOf(empty)).code).toBe("not_found");
  });

  it("has a stale and a large variant", async () => {
    await seedVariant("stale");
    expect((await readProposal()).stale).toBe(true);
    await seedVariant("large");
    const large = await readProposal();
    expect(large.items).toHaveLength(200);
    expect(new Set(large.items.map((item) => item.key)).size).toBe(200);
  });

  it("rejects an unknown variant", async () => {
    const response = await client.send("POST", "/__mock/stage11/seed", {
      variants: { proposals: "gigantic" },
    });
    expect(response.status).toBe(422);
  });

  it("lets a viewer read", async () => {
    expect((await client.get(PROPOSAL_PATH, "viewer")).status).toBe(200);
  });
});

describe("PATCH /proposal-items/{id}", () => {
  it("ticks an item, records who and when, and resets it", async () => {
    const item = firstProposed(await readProposal());
    const ticked = await patch(item.id, { status: "selected" }, "member");
    expect(ticked.status).toBe(200);
    const body = (await ticked.json()) as ProposalItem;
    expect(body.status).toBe("selected");
    expect(body.selected_by).toBe("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e02");
    expect(body.selected_at).not.toBeNull();

    const reset = (await (await patch(item.id, { status: "proposed" })).json()) as ProposalItem;
    expect(reset.status).toBe("proposed");
    expect(reset.selected_by).toBeNull();
    expect(reset.note).toBeNull();
  });

  it("keeps the note on a tick and replaces it when sent", async () => {
    const item = firstProposed(await readProposal());
    await patch(item.id, { status: "declined", note: "  Covered by vendor tests  " });
    const kept = (await (await patch(item.id, { status: "selected" })).json()) as ProposalItem;
    expect(kept.note).toBe("Covered by vendor tests");
    const replaced = (await (
      await patch(item.id, { status: "selected", note: "now in scope" })
    ).json()) as ProposalItem;
    expect(replaced.note).toBe("now in scope");
  });

  it("rejects the system states, a long note and a viewer", async () => {
    const item = firstProposed(await readProposal());
    for (const status of ["authored", "covered", "nonsense"]) {
      const response = await patch(item.id, { status });
      expect(response.status).toBe(422);
      expect((await errorOf(response)).code).toBe("validation_failed");
    }
    const long = await patch(item.id, { status: "declined", note: "x".repeat(301) });
    expect(long.status).toBe(422);
    const viewer = await patch(item.id, { status: "selected" }, "viewer");
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).code).toBe("role_required");
  });

  it("answers 404 for an unknown item and 409 for an authored one", async () => {
    expect((await patch(MISSING_ID, { status: "selected" })).status).toBe(404);
    const authored = (await readProposal()).items.find((item) => item.status === "authored");
    expect(authored).toBeDefined();
    const response = await patch((authored as ProposalItem).id, { status: "selected" });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("conflict");
  });

  it("writes an audit row and publishes proposal.updated on the coverage bus", async () => {
    const messages: Array<{ targetId: string; type: string; payload: object }> = [];
    const stop = coverageBus.subscribe(({ targetId, envelope }) => {
      messages.push({ targetId, type: envelope.type, payload: envelope.payload });
    });
    try {
      const item = firstProposed(await readProposal());
      await patch(item.id, { status: "selected" });
      const proposed = messages.filter((message) => message.type === "proposal.updated");
      expect(proposed).toHaveLength(1);
      expect(proposed[0]?.targetId).toBe(GRACIE);
      expect(proposed[0]?.payload).toMatchObject({
        target_id: GRACIE,
        item_id: item.id,
        status: "selected",
      });
    } finally {
      stop();
    }
    const audit = (await (
      await client.get("/api/v1/audit-events?subject_type=proposal")
    ).json()) as AuditEventPage;
    expect(audit.items.some((event) => event.action === "proposal_item_changed")).toBe(true);
  });
});

describe("PUT /targets/{id}/proposal", () => {
  it("stores a proposal and carries ticks over by key", async () => {
    const first = await put(proposalYaml());
    expect(first.status).toBe(200);
    const stored = (await first.json()) as Proposal;
    expect(stored.source).toBe("put");
    expect(stored.items.map((item) => item.key)).toEqual([
      "smart-log-open-maintenance.core",
      "smart-log-close-issue.core",
    ]);
    const open = stored.items[0] as ProposalItem;
    await patch(open.id, { status: "declined", note: "later" });
    const second = (await (await put(proposalYaml())).json()) as Proposal;
    const carried = second.items.find((item) => item.key === open.key) as ProposalItem;
    expect(carried.status).toBe("declined");
    expect(carried.note).toBe("later");
    expect(carried.id).not.toBe(open.id);
    const retired = await patch(open.id, { status: "selected" });
    expect(retired.status).toBe(409);
  });

  it("answers 422 proposal_invalid with a pointer and a line per problem", async () => {
    const response = await put(
      proposalYaml({
        items: [
          {
            key: "Bad Key",
            title: "x",
            area: "Smart Log",
            feature_ids: ["smart_log.read.open_maintenance"],
            kind: "nope",
            risk: "high",
            reasons: [],
            depth: "smoke",
            confidence: "high",
          },
        ],
      }),
    );
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("proposal_invalid");
    const locs = error.details.map((detail) => detail.loc.join(""));
    expect(locs.some((loc) => loc.endsWith("/items/0/key"))).toBe(true);
    expect(locs.some((loc) => loc.endsWith("/items/0/kind"))).toBe(true);
    expect(error.details.every((detail) => /^line \d+: /.test(detail.message))).toBe(true);
  });

  it("rejects broken YAML, a foreign target token and a secret", async () => {
    const broken = await put("items: [unclosed");
    expect(broken.status).toBe(422);
    expect((await errorOf(broken)).code).toBe("proposal_invalid");
    const foreign = await put(proposalYaml({ target_token: "tgt_other" }));
    expect((await errorOf(foreign)).details[0]?.code).toBe("proposal_target_mismatch");
    const secret = await put(`${proposalYaml()}# sk-abcdefghijklmnopqrstuvwxyz\n`);
    expect(secret.status).toBe(422);
    expect((await errorOf(secret)).code).toBe("bundle_contains_secret");
  });

  it("lowers the confidence of an item whose feature is unknown", async () => {
    const response = await put(
      proposalYaml({
        items: [
          {
            key: "ghost-feature.core",
            title: "A feature that is not in the bundle",
            area: "Smart Log",
            feature_ids: ["ghost.read.nothing"],
            kind: "api",
            risk: "low",
            reasons: [{ code: "complexity" }],
            depth: "smoke",
            confidence: "high",
          },
        ],
      }),
    );
    const stored = (await response.json()) as Proposal;
    expect(stored.items[0]?.confidence).toBe("low");
    expect(stored.items[0]?.cell_ids).toEqual([]);
  });

  it("needs the member role", async () => {
    expect((await put(proposalYaml(), "viewer")).status).toBe(403);
  });
});

describe("POST /targets/{id}/proposal/plan", () => {
  it("answers 422 nothing_selected when nothing is ticked", async () => {
    const seeded = await readProposal();
    for (const item of seeded.items.filter((entry) => entry.status === "selected")) {
      await patch(item.id, { status: "proposed" });
    }
    const response = await client.send("POST", `${PROPOSAL_PATH}/plan`, {});
    expect(response.status).toBe(422);
    expect((await errorOf(response)).details[0]?.code).toBe("nothing_selected");
  });

  it("saves a plan from the selected items that the plans list shows", async () => {
    await put(proposalYaml());
    const stored = await readProposal();
    for (const item of stored.items) {
      await patch(item.id, { status: "selected" });
    }
    const response = await client.send("POST", `${PROPOSAL_PATH}/plan`, { name: "From proposal" });
    expect(response.status).toBe(201);
    const plan = (await response.json()) as Plan;
    expect(plan.saved).toBe(true);
    expect(plan.name).toBe("From proposal");
    expect(plan.selection.feature_ids).toEqual([
      "smart_log.read.open_maintenance",
      "smart_log.write.close_issue",
    ]);
    expect(plan.selection.depth).toBe("standard");

    const detail = await client.get(`/api/v1/plans/${plan.id}`);
    expect(detail.status).toBe(200);
    const listed = (await (
      await client.get(`/api/v1/plans?target_id=${GRACIE}&saved=true`)
    ).json()) as PlanPage;
    expect(listed.items.map((entry) => entry.id)).toContain(plan.id);
  });

  it("plans the named items and rejects unknown ones", async () => {
    await put(proposalYaml());
    const stored = await readProposal();
    const first = stored.items[0] as ProposalItem;
    const planned = await client.send("POST", `${PROPOSAL_PATH}/plan`, { item_ids: [first.id] });
    expect(planned.status).toBe(201);
    const unknown = await client.send("POST", `${PROPOSAL_PATH}/plan`, { item_ids: [MISSING_ID] });
    expect(unknown.status).toBe(422);
    expect((await errorOf(unknown)).details[0]?.code).toBe("item_not_found");
  });

  it("needs the member role and answers 404 without a proposal", async () => {
    expect(
      (await client.send("POST", `${PROPOSAL_PATH}/plan`, {}, { role: "viewer" })).status,
    ).toBe(403);
    const other = await client.send(
      "POST",
      `/api/v1/targets/${STAGE_ONE_IDS.billing}/proposal/plan`,
      {},
    );
    expect(other.status).toBe(404);
  });
});

describe("markers", () => {
  it("puts proposal_item_ids on coverage cells and drops declined items", async () => {
    await put(proposalYaml());
    const stored = await readProposal();
    const open = stored.items[0] as ProposalItem;
    const readCoverage = async () =>
      (await (
        await client.get(`/api/v1/coverage?target_id=${GRACIE}`)
      ).json()) as MarkedCoverageMap;
    const before = await readCoverage();
    const marked = before.cells.filter((cell) => (cell.proposal_item_ids ?? []).includes(open.id));
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((cell) => cell.feature_id === "smart_log.read.open_maintenance")).toBe(
      true,
    );
    await patch(open.id, { status: "declined" });
    const after = await readCoverage();
    expect(after.cells.some((cell) => (cell.proposal_item_ids ?? []).includes(open.id))).toBe(
      false,
    );
  });

  it("puts proposal_risk on catalog items of proposed features", async () => {
    await put(proposalYaml());
    const catalog = (await (
      await client.get(`/api/v1/catalog?target_id=${GRACIE}`)
    ).json()) as Catalog;
    const items = catalog.areas.flatMap((area) => area.items);
    const open = items.find((item) => item.feature_id === "smart_log.read.open_maintenance");
    const close = items.find((item) => item.feature_id === "smart_log.write.close_issue");
    const other = items.find((item) => item.feature_id === "reports.read.occupancy_summary");
    expect(open).toMatchObject({ proposal_risk: "high" });
    expect(close).toMatchObject({ proposal_risk: "medium" });
    expect(other).not.toHaveProperty("proposal_risk");
  });
});
