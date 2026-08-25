import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import type { components } from "@/lib/api/schema";
import { fixedToken } from "@/mocks/stage1/seed";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage1Client,
  errorOf,
  STAGE_ONE_IDS,
  type Stage1Client,
} from "@/tests/utils/stage1";

type TargetPage = components["schemas"]["TargetPage"];
type Target = components["schemas"]["Target"];

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

async function listNames(query: string, role?: "admin" | "member" | "viewer"): Promise<string[]> {
  const response = await client.get(`/api/v1/targets${query}`, role);
  expect(response.status).toBe(200);
  return ((await response.json()) as TargetPage).items.map((item) => item.name);
}

describe("GET /targets", () => {
  it("requires a token and answers the viewer role", async () => {
    const anonymous = await fetch(`${running.baseUrl}/api/v1/targets`);
    expect(anonymous.status).toBe(401);
    expect(await listNames("", "viewer")).toContain("Gracie");
  });

  it("lists the active seeded targets newest first and hides archived ones", async () => {
    expect(await listNames("")).toEqual(["Broken Import", "Live Shop", "Billing API", "Gracie"]);
    expect(await listNames("?include_archived=true")).toContain("Legacy Portal");
  });

  it("summarises the latest bundle, completeness and overall health", async () => {
    const page = (await (await client.get("/api/v1/targets")).json()) as TargetPage;
    const byName = Object.fromEntries(page.items.map((item) => [item.name, item]));
    expect(byName.Gracie).toMatchObject({
      latest_bundle_version: 2,
      completeness_score: 92,
      health: "failed",
      archived_at: null,
    });
    expect(byName["Billing API"]).toMatchObject({
      latest_bundle_version: null,
      completeness_score: null,
      health: "unchecked",
    });
    expect(byName["Broken Import"]).toMatchObject({
      latest_bundle_version: 1,
      completeness_score: 0,
    });
  });

  it("filters by text, repeated app_kind and tier", async () => {
    expect(await listNames("?q=BILL")).toEqual(["Billing API"]);
    expect(await listNames("?q=live-sh")).toEqual(["Live Shop"]);
    expect(await listNames("?app_kind=api&app_kind=llm_assistant&sort=name")).toEqual([
      "Billing API",
      "Gracie",
    ]);
    expect(await listNames("?tier=production")).toEqual(["Live Shop"]);
  });

  it("sorts by name in both directions", async () => {
    expect(await listNames("?sort=name")).toEqual([
      "Billing API",
      "Broken Import",
      "Gracie",
      "Live Shop",
    ]);
    expect(await listNames("?sort=-name")).toEqual([
      "Live Shop",
      "Gracie",
      "Broken Import",
      "Billing API",
    ]);
  });

  it("pages with an opaque cursor and reports total only on request", async () => {
    const first = (await (await client.get("/api/v1/targets?limit=3")).json()) as TargetPage;
    expect(first.items).toHaveLength(3);
    expect(first.total).toBeNull();
    expect(typeof first.next_cursor).toBe("string");

    const second = (await (
      await client.get(`/api/v1/targets?limit=3&include_total=true&cursor=${first.next_cursor}`)
    ).json()) as TargetPage;
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(second.total).toBe(4);
    const names = [...first.items, ...second.items].map((item) => item.name);
    expect(new Set(names).size).toBe(4);
  });

  it("rejects unknown query keys with the key as the location", async () => {
    const response = await client.get("/api/v1/targets?bogus=1&other=2");
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("validation_failed");
    expect(error.details.map((detail) => detail.loc)).toEqual([
      ["query", "bogus"],
      ["query", "other"],
    ]);
  });

  it("rejects unknown sort keys, bad limits, tampered cursors and cursors of another sort", async () => {
    const sort = await errorOf(await client.get("/api/v1/targets?sort=slug"));
    expect(sort.details[0]).toMatchObject({ loc: ["query", "sort"], code: "unknown_sort_key" });

    const limit = await client.get("/api/v1/targets?limit=201");
    expect(limit.status).toBe(422);
    expect((await errorOf(limit)).details[0]?.loc).toEqual(["query", "limit"]);

    const tampered = await errorOf(await client.get("/api/v1/targets?cursor=abc"));
    expect(tampered.details[0]).toMatchObject({ loc: ["query", "cursor"], code: "invalid_cursor" });

    const first = (await (await client.get("/api/v1/targets?limit=1")).json()) as TargetPage;
    const mismatched = await client.get(
      `/api/v1/targets?limit=1&sort=name&cursor=${first.next_cursor}`,
    );
    expect(mismatched.status).toBe(422);
  });

  it("rejects an unknown enum value for app_kind with its position", async () => {
    const error = await errorOf(
      await client.get("/api/v1/targets?app_kind=web&app_kind=mainframe"),
    );
    expect(error.details[0]).toMatchObject({ loc: ["query", "app_kind", 1], code: "enum" });
  });
});

describe("POST /targets", () => {
  it("creates a qa target with a slug and a routing token", async () => {
    const response = await client.send("POST", "/api/v1/targets", {
      name: "  Gracie  ",
      app_kind: "llm_assistant",
    });
    expect(response.status).toBe(201);
    const target = (await response.json()) as Target;
    expect(target).toMatchObject({
      name: "Gracie",
      slug: "gracie-2",
      tier: "qa",
      allow_production: false,
      latest_bundle_id: null,
      archived_at: null,
      hints: {},
    });
    expect(target.target_token).toMatch(/^tgt_[a-z2-7]{22}$/);
  });

  it("lets a member create but never a production target", async () => {
    const member = await client.send(
      "POST",
      "/api/v1/targets",
      { name: "Fresh", app_kind: "web" },
      { role: "member" },
    );
    const production = await client.send(
      "POST",
      "/api/v1/targets",
      { name: "Live", app_kind: "web", tier: "production" },
      { role: "member" },
    );
    const viewer = await client.send(
      "POST",
      "/api/v1/targets",
      { name: "Nope", app_kind: "web" },
      { role: "viewer" },
    );
    expect(member.status).toBe(201);
    expect(production.status).toBe(403);
    expect((await errorOf(production)).code).toBe("role_required");
    expect(viewer.status).toBe(403);
  });

  it("maps field errors to body locations", async () => {
    const response = await client.send("POST", "/api/v1/targets", { name: "   ", app_kind: "x" });
    expect(response.status).toBe(422);
    const details = (await errorOf(response)).details;
    expect(details).toContainEqual(
      expect.objectContaining({ loc: ["body", "name"], code: "string_too_short" }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({ loc: ["body", "app_kind"], code: "enum" }),
    );
    const missing = await errorOf(await client.send("POST", "/api/v1/targets", {}));
    expect(missing.details.map((detail) => detail.code)).toEqual(["missing", "missing"]);
  });
});

describe("GET, PATCH, DELETE /targets/{id}", () => {
  it("reads a target with its latest bundle id and answers 404 and 422 for bad ids", async () => {
    const found = await client.get(`/api/v1/targets/${STAGE_ONE_IDS.gracie}`, "viewer");
    const target = (await found.json()) as Target;
    expect(target.latest_bundle_id).not.toBeNull();
    expect(target.target_token).toBe(fixedToken("graciedemotoken"));

    const missing = await client.get("/api/v1/targets/0198f6f2-4c2a-7d10-9c1e-000000000000");
    expect(missing.status).toBe(404);
    const malformed = await client.get("/api/v1/targets/not-a-uuid");
    expect(malformed.status).toBe(422);
    expect((await errorOf(malformed)).details[0]).toMatchObject({
      loc: ["path", "target_id"],
      code: "uuid_parsing",
    });
  });

  it("edits name, kind and hints but keeps the slug", async () => {
    const response = await client.send(
      "PATCH",
      `/api/v1/targets/${STAGE_ONE_IDS.billing}`,
      { name: "Billing Core", hints: { team: "payments" } },
      { role: "member" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "Billing Core",
      slug: "billing-api",
      hints: { team: "payments" },
    });
  });

  it("accepts an empty patch and refuses null for required fields", async () => {
    const path = `/api/v1/targets/${STAGE_ONE_IDS.billing}`;
    const empty = await client.send("PATCH", path, {}, { role: "member" });
    expect(empty.status).toBe(200);
    for (const field of ["name", "app_kind", "tier", "allow_production", "hints"]) {
      const response = await client.send("PATCH", path, { [field]: null }, { role: "member" });
      expect(response.status).toBe(422);
      expect((await errorOf(response)).details[0]).toMatchObject({
        loc: ["body", field],
        code: "null_not_allowed",
      });
    }
  });

  it("keeps allow_production and production tier changes admin only", async () => {
    const path = `/api/v1/targets/${STAGE_ONE_IDS.billing}`;
    for (const body of [{ allow_production: true }, { tier: "production" }]) {
      const denied = await client.send("PATCH", path, body, { role: "member" });
      expect(denied.status).toBe(403);
      expect((await errorOf(denied)).code).toBe("role_required");
    }
    const lowered = await client.send(
      "PATCH",
      `/api/v1/targets/${STAGE_ONE_IDS.liveShop}`,
      { tier: "qa" },
      { role: "member" },
    );
    expect(lowered.status).toBe(403);
    const repeated = await client.send(
      "PATCH",
      path,
      { tier: "qa", allow_production: false, name: "Renamed" },
      { role: "member" },
    );
    expect(repeated.status).toBe(200);
    const promoted = await client.send("PATCH", path, {
      tier: "production",
      allow_production: true,
    });
    expect(await promoted.json()).toMatchObject({ tier: "production", allow_production: true });
  });

  it("archives for admins only, idempotently, and keeps reads working", async () => {
    const path = `/api/v1/targets/${STAGE_ONE_IDS.billing}`;
    expect((await client.send("DELETE", path, undefined, { role: "member" })).status).toBe(403);
    const archived = await client.send("DELETE", path);
    expect(archived.status).toBe(204);
    expect(await archived.text()).toBe("");
    expect((await client.send("DELETE", path)).status).toBe(204);

    expect(await listNames("")).not.toContain("Billing API");
    const detail = (await (await client.get(path)).json()) as Target;
    expect(detail.archived_at).not.toBeNull();
  });

  it("refuses edits and token rotation on an archived target with 409", async () => {
    const path = `/api/v1/targets/${STAGE_ONE_IDS.legacyPortal}`;
    const edit = await client.send("PATCH", path, { name: "X" }, { role: "member" });
    const rotate = await client.send("POST", `${path}/token/rotate`, undefined, { role: "member" });
    expect(edit.status).toBe(409);
    expect((await errorOf(edit)).code).toBe("conflict");
    expect(rotate.status).toBe(409);
  });

  it("rotates the token and keeps the previous one matching uploads", async () => {
    const path = `/api/v1/targets/${STAGE_ONE_IDS.billing}/token/rotate`;
    const before = (await (
      await client.get(`/api/v1/targets/${STAGE_ONE_IDS.billing}`)
    ).json()) as Target;
    const rotated = (await (
      await client.send("POST", path, undefined, { role: "member" })
    ).json()) as Target;
    expect(rotated.target_token).not.toBe(before.target_token);
    const stored = mockState.stageOne.findTarget(STAGE_ONE_IDS.billing);
    expect(stored?.previousTargetToken).toBe(before.target_token);
    expect(mockState.stageOne.findTargetByToken(before.target_token)?.matchedPrevious).toBe(true);
    expect((await client.send("POST", path, undefined, { role: "viewer" })).status).toBe(403);
  });
});

describe("GET /limits and GET /app-kinds", () => {
  it("serves the upload limits and follows reconfiguration", async () => {
    const body = await (await client.get("/api/v1/limits", "viewer")).json();
    expect(body).toEqual({
      bundle_max_zip_bytes: 26_214_400,
      bundle_max_manifest_bytes: 1_048_576,
      replay_max_bytes: null,
      explanation_max_chars: null,
    });
    mockState.stageOne.configureLimits({ bundle_max_zip_bytes: 1000 });
    expect(
      ((await (await client.get("/api/v1/limits")).json()) as { bundle_max_zip_bytes: number })
        .bundle_max_zip_bytes,
    ).toBe(1000);
    mockState.reset();
    expect(
      ((await (await client.get("/api/v1/limits")).json()) as { bundle_max_zip_bytes: number })
        .bundle_max_zip_bytes,
    ).toBe(26_214_400);
    expect((await fetch(`${running.baseUrl}/api/v1/limits`)).status).toBe(401);
  });

  it("lists every app kind with hints and a default-on flag", async () => {
    const body = (await (
      await client.get("/api/v1/app-kinds", "viewer")
    ).json()) as components["schemas"]["AppKindList"];
    expect(body.items.map((item) => item.kind)).toEqual([
      "web",
      "api",
      "llm_assistant",
      "worker",
      "cli",
    ]);
    const assistant = body.items.find((item) => item.kind === "llm_assistant");
    expect(assistant?.hints.map((hint) => hint.id)).toEqual([
      "list_tools",
      "confirmation_gate",
      "transcript_trace_endpoints",
    ]);
    expect(body.items.find((item) => item.kind === "api")?.hints[1]?.default_on).toBe(false);
  });
});
