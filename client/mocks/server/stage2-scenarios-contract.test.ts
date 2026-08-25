import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import type { Scenario, ScenarioSummaryPage } from "@/lib/api/types";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage2Client,
  errorOf,
  GRACIE_ID,
  STAGE_ONE_IDS,
  STAGE_TWO_IDS,
  type Stage2Client,
} from "@/tests/utils/stage2";

const SYNTHETIC_FAMILIES = ["invariant", "api_fuzz", "exploration", "simulation", "redteam"];

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

async function list(query = ""): Promise<ScenarioSummaryPage> {
  const response = await client.get(`/api/v1/scenarios${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ScenarioSummaryPage;
}

describe("GET /scenarios", () => {
  it("lists the generated smoke scenarios of the Gracie catalog and hides synthetic ones", async () => {
    const page = await list(`?target_id=${GRACIE_ID}&include_total=true&limit=200`);
    expect(page.items.every((item) => !item.synthetic)).toBe(true);
    expect(page.items.some((item) => SYNTHETIC_FAMILIES.includes(item.family))).toBe(false);
    const smoke = page.items.filter((item) => item.origin === "bundle_example");
    expect(smoke).toHaveLength(57);
    expect(page.total).toBe(page.items.length);
    expect(page.items[0]).toEqual(
      expect.objectContaining({
        target_id: GRACIE_ID,
        version: expect.any(Number),
        validation: expect.objectContaining({ valid: expect.any(Boolean) }),
        created_at: expect.any(String),
      }),
    );
    expect("yaml" in (page.items[0] ?? {})).toBe(false);
    expect("parsed" in (page.items[0] ?? {})).toBe(false);
  });

  it("includes synthetic families only with include_synthetic=true", async () => {
    const visible = await list("?include_total=true");
    const all = await list("?include_synthetic=true&include_total=true&limit=200");
    expect((all.total ?? 0) - (visible.total ?? 0)).toBe(6);
    const synthetic = all.items.filter((item) => item.synthetic);
    expect(new Set(synthetic.map((item) => item.family))).toEqual(new Set(SYNTHETIC_FAMILIES));
  });

  it("filters by status, origin, family and feature_id with repeated values", async () => {
    const inReview = await list("?status=in_review&status=invalid");
    expect(new Set(inReview.items.map((item) => item.status))).toEqual(
      new Set(["in_review", "invalid"]),
    );
    const authored = await list("?origin=authored&origin=promoted_finding");
    expect(new Set(authored.items.map((item) => item.origin))).toEqual(
      new Set(["authored", "promoted_finding"]),
    );
    const family = await list("?family=reports&limit=200");
    expect(family.items.length).toBeGreaterThan(0);
    expect(family.items.every((item) => item.family === "reports")).toBe(true);
    const feature = await list(
      "?feature_id=smart_log.read.issue_detail&feature_id=smart_log.write.close_issue&limit=200",
    );
    expect(new Set(feature.items.map((item) => item.feature_id))).toEqual(
      new Set(["smart_log.read.issue_detail", "smart_log.write.close_issue"]),
    );
  });

  it("searches q in the title, feature id and family, ignoring case", async () => {
    const byTitle = await list("?q=CONFIRM%20button");
    expect(byTitle.items.map((item) => item.title)).toEqual([
      "Closing an issue needs the Confirm button",
    ]);
    const byFeature = await list("?q=issue_detail&limit=200");
    expect(byFeature.items.every((item) => item.feature_id === "smart_log.read.issue_detail")).toBe(
      true,
    );
    expect((await list("?q=zzzz-no-match")).items).toEqual([]);
  });

  it("filters by plan_id to the scenarios covering the plan's cells", async () => {
    const page = await list(`?plan_id=${STAGE_TWO_IDS.plans.smartLog}&limit=200`);
    expect(page.items).toHaveLength(12);
    expect(page.items.every((item) => item.origin === "bundle_example")).toBe(true);
    const unknown = await list("?plan_id=0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff");
    expect(unknown.items).toEqual([]);
  });

  it("filters by cell_id, using the scenario's own cell id or a plan cell id", async () => {
    const [first] = (await list("?feature_id=smart_log.read.issue_detail")).items;
    expect(first?.cell_id).not.toBeNull();
    const byCell = await list(`?cell_id=${first?.cell_id}`);
    expect(byCell.items.map((item) => item.id)).toEqual([first?.id]);

    const cells = (await (
      await client.get(`/api/v1/plans/${STAGE_TWO_IDS.plans.smartLog}/cells?limit=200`)
    ).json()) as { items: Array<{ id: string; feature_id: string; role: string }> };
    const planCell = cells.items.find((cell) => cell.feature_id === "smart_log.read.issue_detail");
    const viaPlanCell = await list(`?cell_id=${planCell?.id}`);
    expect(viaPlanCell.items).toHaveLength(1);
    expect(viaPlanCell.items[0]?.feature_id).toBe("smart_log.read.issue_detail");
  });

  it("matches nothing for replay_id before Stage 7", async () => {
    const page = await list("?replay_id=0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff");
    expect(page.items).toEqual([]);
  });

  it("sorts by title and paginates by cursor without repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ScenarioSummaryPage = await list(
        `?sort=title&limit=25${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      seen.push(...page.items.map((item) => item.title));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBeGreaterThan(2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort((left, right) => left.localeCompare(right)));
  });

  it("rejects unknown filters, sort keys and malformed uuids with 422", async () => {
    for (const query of ["?nope=1", "?sort=family", "?target_id=abc", "?status=asleep"]) {
      const response = await client.get(`/api/v1/scenarios${query}`);
      expect(response.status).toBe(422);
    }
  });

  it("scopes by target and is open to the viewer", async () => {
    const billing = await list(`?target_id=${STAGE_ONE_IDS.billing}`);
    expect(billing.items).toEqual([]);
    const response = await client.get("/api/v1/scenarios", "viewer");
    expect(response.status).toBe(200);
  });

  it("is empty on the empty seed and fills lazily when a run needs a scenario", async () => {
    await client.control.seed("empty");
    expect((await list()).items).toEqual([]);
    await client.startInlineRun();
    const page = await list(`?target_id=${GRACIE_ID}`);
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.origin === "bundle_example")).toBe(true);
  });
});

describe("GET /scenarios/{id}", () => {
  it("returns the YAML, the parsed document and the validation of a smoke scenario", async () => {
    const [summary] = (
      await list("?feature_id=smart_log.read.open_maintenance&origin=bundle_example&limit=1")
    ).items;
    const response = await client.get(`/api/v1/scenarios/${summary?.id}`);
    expect(response.status).toBe(200);
    const scenario = (await response.json()) as Scenario;
    expect(scenario.yaml.startsWith("schema_version: 1\n")).toBe(true);
    expect(scenario.yaml).toContain("feature_id: smart_log.read.open_maintenance");
    expect(scenario.yaml).toContain("steps:");
    expect(scenario.parsed).toMatchObject({
      schema_version: 1,
      feature_id: "smart_log.read.open_maintenance",
      synthetic: false,
    });
    expect(Array.isArray(scenario.parsed.steps)).toBe(true);
    expect(scenario).toMatchObject({
      origin: "bundle_example",
      status: "accepted",
      version: 1,
      synthetic: false,
      validation: { valid: true, errors: [], warnings: [] },
    });
  });

  it("returns validation errors of an invalid scenario and the synthetic flag", async () => {
    const invalid = (await list("?status=invalid")).items[0];
    const detail = (await (
      await client.get(`/api/v1/scenarios/${invalid?.id}`)
    ).json()) as Scenario;
    expect(detail.validation.valid).toBe(false);
    expect(detail.validation.errors[0]).toEqual({
      code: "path_not_absolute",
      pointer: "/steps/0/request/path",
      line: 9,
      column: 11,
      message: "path must start with /",
    });
    const synthetic = (await list("?include_synthetic=true&family=redteam")).items[0];
    const redteam = (await (
      await client.get(`/api/v1/scenarios/${synthetic?.id}`)
    ).json()) as Scenario;
    expect(redteam.synthetic).toBe(true);
    expect(redteam.parsed.synthetic).toBe(true);
  });

  it("answers 404 for an unknown id and 422 for a malformed one", async () => {
    const missing = await client.get("/api/v1/scenarios/0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff");
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("not_found");
    expect((await client.get("/api/v1/scenarios/nope")).status).toBe(422);
  });

  it("gives every cell a deterministic scenario id that survives a reset", async () => {
    const before = (await list("?limit=200&sort=title")).items.map((item) => item.id);
    mockState.reset();
    const after = (await list("?limit=200&sort=title")).items.map((item) => item.id);
    expect(after).toEqual(before);
  });
});
