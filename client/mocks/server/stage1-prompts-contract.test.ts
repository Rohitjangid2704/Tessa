import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { components } from "@/lib/api/schema";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage1Client,
  errorOf,
  STAGE_ONE_IDS,
  type Stage1Client,
} from "@/tests/utils/stage1";

type PromptIssue = components["schemas"]["PromptIssue"];
type PromptIssuePage = components["schemas"]["PromptIssuePage"];
type PromptTemplate = components["schemas"]["PromptTemplate"];
type PromptTemplatePage = components["schemas"]["PromptTemplatePage"];

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

const issuesPath = (targetId: string) => `/api/v1/targets/${targetId}/prompt-issues`;

describe("prompt templates", () => {
  it("lists two versions of discovery and of fixup, name ascending and newest version first", async () => {
    const page = (await (
      await client.get("/api/v1/prompt-templates", "viewer")
    ).json()) as PromptTemplatePage;
    expect(page.items.map((item) => `${item.name}@${item.version}`)).toEqual([
      "discovery@2",
      "discovery@1",
      "fixup@2",
      "fixup@1",
    ]);
    expect(page.items[0]?.variables).toEqual(["SCHEMA_URL", "TARGET_TOKEN", "APP_KIND_HINTS"]);
    expect(page.next_cursor).toBeNull();
  });

  it("pages and sorts like every list", async () => {
    const first = (await (
      await client.get("/api/v1/prompt-templates?limit=3&sort=version&include_total=true")
    ).json()) as PromptTemplatePage;
    expect(first.items.map((item) => item.version)).toEqual([1, 1, 2]);
    expect(first.total).toBe(4);
    const unknown = await client.get("/api/v1/prompt-templates?name=discovery");
    expect(unknown.status).toBe(422);
    expect((await errorOf(unknown)).details[0]?.loc).toEqual(["query", "name"]);
  });

  it("reads the current version, a pinned version and answers 404 for gaps", async () => {
    const current = (await (
      await client.get("/api/v1/prompt-templates/discovery", "viewer")
    ).json()) as PromptTemplate;
    expect(current.version).toBe(2);
    expect(current.text).toContain("{{TARGET_TOKEN}}");
    expect(current.text).toContain("{{SCHEMA_URL}}");

    const pinned = (await (
      await client.get("/api/v1/prompt-templates/discovery?version=1")
    ).json()) as PromptTemplate;
    expect(pinned.version).toBe(1);
    expect(pinned.text).not.toContain("Format conventions");

    expect((await client.get("/api/v1/prompt-templates/discovery?version=9")).status).toBe(404);
    expect((await client.get("/api/v1/prompt-templates/explain")).status).toBe(404);
    const badName = await client.get("/api/v1/prompt-templates/nope");
    expect(badName.status).toBe(422);
    expect((await errorOf(badName)).details[0]).toMatchObject({
      loc: ["path", "name"],
      code: "enum",
    });
    const badVersion = await client.get("/api/v1/prompt-templates/discovery?version=0");
    expect((await errorOf(badVersion)).details[0]?.loc).toEqual(["query", "version"]);
  });
});

describe("POST /targets/{id}/prompt-issues, discovery", () => {
  it("renders the token, the schema url on the request origin and the chosen hints", async () => {
    const response = await client.send(
      "POST",
      issuesPath(STAGE_ONE_IDS.gracie),
      { template_name: "discovery", hint_ids: ["list_tools", "confirmation_gate"] },
      { role: "member" },
    );
    expect(response.status).toBe(201);
    const issue = (await response.json()) as PromptIssue;
    expect(issue).toMatchObject({
      target_id: STAGE_ONE_IDS.gracie,
      template_name: "discovery",
      template_version: 2,
      target_token: "tgt_graciedemotokenaaaaaaa",
      params: { template_name: "discovery", hint_ids: ["list_tools", "confirmation_gate"] },
    });
    expect(issue.text).toContain("target_token tgt_graciedemotokenaaaaaaa");
    expect(issue.text).toContain(`${running.baseUrl}/schemas/bundle.v1.json`);
    expect(issue.text).toContain("List every tool the assistant can call");
    expect(issue.text).toContain("Describe the confirmation gate");
    expect(issue.text).not.toContain("transcript and a per-turn trace");
    expect(issue.text).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("says so when no hint is selected and defaults hint_ids to empty", async () => {
    const issue = (await (
      await client.send("POST", issuesPath(STAGE_ONE_IDS.gracie), { template_name: "discovery" })
    ).json()) as PromptIssue;
    expect(issue.params).toEqual({ template_name: "discovery", hint_ids: [] });
    expect(issue.text).toContain("No app-specific instructions were selected.");
  });

  it("rejects hints of another app kind", async () => {
    const response = await client.send("POST", issuesPath(STAGE_ONE_IDS.gracie), {
      template_name: "discovery",
      hint_ids: ["list_tools", "openapi_schema"],
    });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).details[0]).toMatchObject({
      loc: ["body", "hint_ids", 1],
      code: "unknown_hint",
    });
  });

  it("validates the discriminated body", async () => {
    const path = issuesPath(STAGE_ONE_IDS.gracie);
    const noTag = await errorOf(await client.send("POST", path, {}));
    expect(noTag.details[0]).toMatchObject({ loc: ["body"], code: "union_tag_not_found" });
    const badTag = await errorOf(await client.send("POST", path, { template_name: "explain" }));
    expect(badTag.details[0]).toMatchObject({ loc: ["body"], code: "union_tag_invalid" });
    const noBundle = await errorOf(await client.send("POST", path, { template_name: "fixup" }));
    expect(noBundle.details[0]).toMatchObject({
      loc: ["body", "fixup", "bundle_id"],
      code: "missing",
    });
    const badHints = await errorOf(
      await client.send("POST", path, { template_name: "discovery", hint_ids: "list_tools" }),
    );
    expect(badHints.details[0]).toMatchObject({ loc: ["body", "discovery", "hint_ids"] });
  });

  it("needs the member role, an existing target and an active target", async () => {
    const body = { template_name: "discovery" };
    expect(
      (await client.send("POST", issuesPath(STAGE_ONE_IDS.gracie), body, { role: "viewer" }))
        .status,
    ).toBe(403);
    expect(
      (await client.send("POST", issuesPath("0198f6f2-4c2a-7d10-9c1e-000000000000"), body)).status,
    ).toBe(404);
    expect((await client.send("POST", issuesPath(STAGE_ONE_IDS.legacyPortal), body)).status).toBe(
      409,
    );
  });

  it("replays an issue for the same Idempotency-Key and refuses a different body", async () => {
    const headers = { "Idempotency-Key": "prompt-issue-key-0001" };
    const path = issuesPath(STAGE_ONE_IDS.gracie);
    const first = await client.send("POST", path, { template_name: "discovery" }, { headers });
    const second = await client.send("POST", path, { template_name: "discovery" }, { headers });
    expect(first.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(((await second.json()) as PromptIssue).id).toBe(
      ((await first.json()) as PromptIssue).id,
    );
    expect(mockState.stageOne.promptIssues).toHaveLength(1);

    const other = await client.send(
      "POST",
      path,
      { template_name: "discovery", hint_ids: ["list_tools"] },
      { headers },
    );
    expect(other.status).toBe(409);
    expect((await errorOf(other)).code).toBe("idempotency_conflict");

    const short = await client.send(
      "POST",
      path,
      { template_name: "discovery" },
      {
        headers: { "Idempotency-Key": "short" },
      },
    );
    expect(short.status).toBe(400);
    expect((await errorOf(short)).code).toBe("idempotency_key_required");
  });
});

describe("POST /targets/{id}/prompt-issues, fixup", () => {
  it("lists exactly the checks that did not earn their weight and the validation errors", async () => {
    const bundles = mockState.stageOne.bundlesOf(STAGE_ONE_IDS.gracie);
    const belowBar = bundles[0];
    const issue = (await (
      await client.send("POST", issuesPath(STAGE_ONE_IDS.gracie), {
        template_name: "fixup",
        bundle_id: belowBar?.bundle.id,
      })
    ).json()) as PromptIssue;
    expect(issue).toMatchObject({ template_name: "fixup", template_version: 2 });
    expect(issue.text).toContain("validated version 1 of the bundle");
    expect(issue.text).toContain("scored its completeness 55 out of 100; the bar is");
    expect(issue.text).toContain("80. The open items are listed below.");
    for (const failing of [
      "[check] completeness check feature_interface_roles: Features name interfaces and roles: 12 of 15 points.",
      "[check] completeness check feature_examples: Features carry concrete examples: 8 of 20 points.",
      "[check] completeness check oracle_read_only: Read-only oracle per computable feature: 5 of 15 points.",
      "[check] completeness check env_template_coverage: env.template covers every placeholder: 10 of 15 points.",
      "[check] completeness check seeds_reset_and_hash: Seeds with a reset script and a hash command: 0 of 15 points.",
    ]) {
      expect(issue.text).toContain(failing);
    }
    expect(issue.text).not.toContain("completeness check required_sections");
    expect(issue.text.indexOf("seeds_reset_and_hash")).toBeLessThan(
      issue.text.indexOf("feature_interface_roles"),
    );
    expect(issue.text).toContain("[warning] seeds/dump.bin: file_ignored");
    expect(issue.text).toContain("   To fix: Add a reset script under seeds/");
    expect(issue.text).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("lists validation errors with file and line for an invalid bundle", async () => {
    const invalid = mockState.stageOne.bundlesOf(STAGE_ONE_IDS.brokenImport)[0];
    const issue = (await (
      await client.send("POST", issuesPath(STAGE_ONE_IDS.brokenImport), {
        template_name: "fixup",
        bundle_id: invalid?.bundle.id,
      })
    ).json()) as PromptIssue;
    expect(issue.text).toContain(
      "[error] manifest.yaml, /seeds, line 212: required_property_missing",
    );
    expect(issue.text).toContain("[error] flows/request_and_track.yaml, line 14: invalid_yaml");
  });

  it("answers 404 for an unknown bundle or a bundle of another target", async () => {
    const other = mockState.stageOne.bundlesOf(STAGE_ONE_IDS.brokenImport)[0];
    const crossed = await client.send("POST", issuesPath(STAGE_ONE_IDS.gracie), {
      template_name: "fixup",
      bundle_id: other?.bundle.id,
    });
    expect(crossed.status).toBe(404);
  });
});

describe("prompt history", () => {
  it("lists issues newest first, filters by template and re-opens one", async () => {
    const path = issuesPath(STAGE_ONE_IDS.gracie);
    const discovery = (await (
      await client.send("POST", path, { template_name: "discovery" })
    ).json()) as PromptIssue;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fixup = (await (
      await client.send("POST", path, {
        template_name: "fixup",
        bundle_id: mockState.stageOne.latestBundle(STAGE_ONE_IDS.gracie)?.bundle.id,
      })
    ).json()) as PromptIssue;

    const all = (await (await client.get(path, "viewer")).json()) as PromptIssuePage;
    expect(all.items.map((item) => item.id)).toEqual([fixup.id, discovery.id]);
    const onlyDiscovery = (await (
      await client.get(`${path}?template_name=discovery`)
    ).json()) as PromptIssuePage;
    expect(onlyDiscovery.items.map((item) => item.id)).toEqual([discovery.id]);
    const badName = await client.get(`${path}?template_name=nope`);
    expect(badName.status).toBe(422);

    const reopened = (await (
      await client.get(`/api/v1/prompt-issues/${discovery.id}`, "viewer")
    ).json()) as PromptIssue;
    expect(reopened).toEqual(discovery);
    expect(
      (await client.get("/api/v1/prompt-issues/0198f6f2-4c2a-7d10-9c1e-000000000000")).status,
    ).toBe(404);
    expect((await client.get(issuesPath("0198f6f2-4c2a-7d10-9c1e-000000000000"))).status).toBe(404);
  });
});
