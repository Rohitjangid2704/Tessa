import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_RESULT_BYTES } from "../src/cut";
import { Redactor } from "../src/redact";
import { TOOLS } from "../src/tools";
import { executeTool, type ToolContext } from "../src/tools/define";
import { IDS, TARGET_TOKEN, TOKEN, proposalDoc, uuidFor } from "./fixtures";
import { createHarness, mswServer } from "./harness";

const LIST_LENGTH = 300;
const FILLER = `${TOKEN} "quoted" \\ back\\slash é漢😀 Bearer ${TOKEN} <tag> `.repeat(60);
const KEEP = /^([a-z_]{1,30}|[0-9a-f-]{36}|\d{4}-\d{2}-\d{2}T[0-9:.]+Z?)$/;

function inflate(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(inflate);
    return items.length === 0 ? items : Array.from({ length: LIST_LENGTH }, (_, index) => items[index % items.length]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, inflate(entry)]));
  }
  if (typeof value === "string" && !KEEP.test(value)) {
    return `${value} ${FILLER}`;
  }
  return value;
}

function inflatingFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
    if (!response.ok || !isJson || new URL(request.url).pathname.startsWith("/schemas/")) {
      return response;
    }
    const body = inflate(await response.json());
    return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const CALLS: Array<[string, Record<string, unknown>]> = [
  ["whoami", {}],
  ["list_targets", { limit: 200 }],
  ["get_target", { target_id: IDS.target }],
  ["issue_prompt", { target_id: IDS.target, template: "discovery" }],
  ["validate_bundle", { path: "BUNDLE" }],
  ["upload_bundle", { path: "BUNDLE" }],
  ["get_bundle", { bundle_id: IDS.bundle }],
  ["get_environment", { target_id: IDS.target }],
  ["set_environment", { target_id: IDS.target, values: { GRAPHQL_URL: "http://localhost:8521" } }],
  ["run_health_checks", { target_id: IDS.target }],
  ["start_run", { plan_id: IDS.plan }],
  ["wait_run", { run_id: IDS.run }],
  ["get_run", { run_id: IDS.run, limit: 200 }],
  ["get_step", { step_id: IDS.step }],
  ["run_diff", { run_id: IDS.run }],
  ["cancel_run", { run_id: IDS.run }],
  ["list_findings", { target_id: IDS.target, limit: 200 }],
  ["get_finding", { finding_id: IDS.finding }],
  ["add_explanation", { finding_id: IDS.finding, text: "The refund path rounds twice." }],
  ["move_finding", { finding_id: IDS.finding, status: "triaged" }],
  ["get_proposal", { target_id: IDS.target }],
  ["put_proposal", { path: "BUNDLE", target_id: IDS.target }],
  ["update_proposal_item", { item_id: uuidFor("1000000a", 1), status: "selected" }],
  ["plan_from_proposal", { target_id: IDS.target }],
  ["get_coverage", { target_id: IDS.target }],
  ["validate_scenario", { yaml: "id: a\n", target_id: IDS.target }],
  ["list_scenarios", { target_id: IDS.target, limit: 200 }],
  ["inbox", {}],
];

let bundleRoot: string;

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());

beforeEach(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "tessa-limits-"));
  const folder = join(bundleRoot, "tessa");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.yaml"), `target_token: ${TARGET_TOKEN}\napp:\n  name: Demo\n`);
  await writeFile(join(folder, "proposal.yaml"), stringify(proposalDoc(2)));
});

afterEach(async () => {
  await rm(bundleRoot, { recursive: true, force: true });
});

describe("every tool result fits the limit and never carries the token", () => {
  it("calls every tool", () => {
    expect(CALLS.map(([name]) => name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
  });

  it.each(CALLS)("%s, when every list of the API answer is long and every text is huge", async (name, args) => {
    const harness = createHarness({ fetchImpl: inflatingFetch() });
    await harness.inboxStore.append(Array.from({ length: 200 }, (_, index) => `kind=finding.created target=t id=i${index} ${FILLER}`), "2026-10-14T10:00:00Z");
    const resolved = JSON.parse(JSON.stringify(args).replace('"BUNDLE"', JSON.stringify(bundleRoot))) as Record<string, unknown>;
    const result = await harness.call(name, resolved);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(result.text).not.toContain(TOKEN);
    expect(result.text).not.toContain(TOKEN.slice(4, 24));
  });
});

describe("the size limit itself", () => {
  const context = (value: unknown): [Parameters<typeof executeTool>[0], ToolContext] => {
    const redactor = new Redactor();
    const definition = {
      name: "probe",
      title: "Probe",
      description: "Read. Test probe.",
      access: "read" as const,
      destructive: false,
      idempotent: true,
      input: {},
      run: async () => value,
    };
    const toolContext = { session: { settled: async () => undefined }, redactor } as unknown as ToolContext;
    return [definition, toolContext];
  };

  it.each([
    ["many short quoted strings", { items: Array.from({ length: 20_000 }, (_, index) => ({ id: index, name: `"n${index}"` })) }],
    ["multibyte text", { text: "漢😀".repeat(100_000) }],
    ["backslashes", { text: "\\".repeat(200_000) }],
    ["control characters", { text: "\u0001\n\t".repeat(100_000) }],
  ])("keeps %s under the limit with a valid JSON preview", async (_label, value) => {
    const [definition, toolContext] = context(value);
    const result = await executeTool(definition, toolContext, {});
    const text = result.content[0]?.text ?? "";
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    const parsed = JSON.parse(text) as { truncated: boolean; preview: string; original_bytes: number };
    expect(parsed.truncated).toBe(true);
    expect(parsed.original_bytes).toBe(Buffer.byteLength(JSON.stringify(value)));
    expect(parsed.preview.length).toBeGreaterThan(10_000);
    expect(JSON.stringify(value).startsWith(parsed.preview)).toBe(true);
  });
});
