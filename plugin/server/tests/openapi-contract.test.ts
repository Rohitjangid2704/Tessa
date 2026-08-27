import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FEEDS, Inbox } from "../src/inbox";
import { MemoryInboxStore } from "../src/inbox-store";
import { validateAgainstSchema } from "../src/jsonschema";
import { Redactor } from "../src/redact";
import { TOOLS } from "../src/tools";
import { EXPLANATION_TEXT_MAX_CHARS } from "../src/tools/findings";
import { BASE_URL, IDS, TARGET_TOKEN, TOKEN, proposalDoc, uuidFor } from "./fixtures";
import { createFakeClock, createHarness, mswServer } from "./harness";

type Json = Record<string, any>;

type FormValue = string | File;

type Captured = {
  method: string;
  url: URL;
  headers: Headers;
  contentType: string;
  hasBody: boolean;
  json?: unknown;
  form?: Array<[string, FormValue]>;
  status: number;
  responseJson?: unknown;
};

type Route = { template: string; names: string[]; pattern: RegExp };

const here = dirname(fileURLToPath(import.meta.url));
const OPENAPI = JSON.parse(readFileSync(resolve(here, "..", "..", "..", "api", "openapi.json"), "utf8")) as Json;
const LOCAL_TOOLS = new Set(["inbox"]);

const ROUTES: Route[] = Object.keys(OPENAPI.paths)
  .map((template) => ({
    template,
    names: [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string),
    pattern: new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "([^/]+)")}$`),
  }))
  .sort((left, right) => left.names.length - right.names.length);

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lookup(reference: string): Json {
  let current: unknown = OPENAPI;
  for (const part of reference.slice(2).split("/")) {
    current = isRecord(current) ? current[part] : undefined;
  }
  if (!isRecord(current)) {
    throw new Error(`api/openapi.json does not resolve ${reference}`);
  }
  return current;
}

function deref(schema: unknown): Json {
  let current = isRecord(schema) ? schema : {};
  while (typeof current.$ref === "string") {
    current = lookup(current.$ref);
  }
  return current;
}

function branchFor(schema: unknown, value: unknown): Json | string {
  const resolved = deref(schema);
  if (!isRecord(resolved.discriminator)) {
    return resolved;
  }
  const property = String(resolved.discriminator.propertyName);
  const tag = isRecord(value) ? value[property] : undefined;
  const reference = isRecord(resolved.discriminator.mapping) ? resolved.discriminator.mapping[String(tag)] : undefined;
  return typeof reference === "string" ? lookup(reference) : `has no ${property} branch for ${JSON.stringify(tag)}`;
}

function schemaIssues(schema: unknown, value: unknown): string[] {
  const branch = branchFor(schema, value);
  if (typeof branch === "string") {
    return [branch];
  }
  return validateAgainstSchema({ ...branch, components: OPENAPI.components }, value, 50).map(
    (issue) => `${issue.pointer === "" ? "/" : issue.pointer} ${issue.message}`,
  );
}

function fitsType(schema: Json, value: unknown): boolean {
  switch (schema.type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function unknownKeys(schema: unknown, value: unknown, path: string[] = []): string[] {
  const branch = branchFor(schema, value);
  if (typeof branch === "string" || value === null || value === undefined) {
    return [];
  }
  const alternatives = (branch.anyOf ?? branch.oneOf) as unknown[] | undefined;
  if (Array.isArray(alternatives)) {
    let best: string[] | null = null;
    for (const alternative of alternatives.map(deref).filter((entry) => entry.type !== "null" && fitsType(entry, value))) {
      const found = unknownKeys(alternative, value, path);
      if (best === null || found.length < best.length) {
        best = found;
      }
    }
    return best ?? [];
  }
  if (Array.isArray(value)) {
    return isRecord(branch.items) ? value.flatMap((entry, index) => unknownKeys(branch.items, entry, [...path, String(index)])) : [];
  }
  if (!isRecord(value)) {
    return [];
  }
  const properties = isRecord(branch.properties) ? branch.properties : null;
  const found: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (properties !== null && key in properties) {
      found.push(...unknownKeys(properties[key], entry, [...path, key]));
    } else if (isRecord(branch.additionalProperties)) {
      found.push(...unknownKeys(branch.additionalProperties, entry, [...path, key]));
    } else if (properties !== null && branch.additionalProperties !== true) {
      found.push([...path, key].join("."));
    }
  }
  return found;
}

function scalarType(schema: unknown): string | undefined {
  const resolved = deref(schema);
  if (typeof resolved.type === "string" && resolved.type !== "null") {
    return resolved.type;
  }
  for (const branch of (resolved.anyOf ?? []) as unknown[]) {
    const type = scalarType(branch);
    if (type !== undefined) {
      return type;
    }
  }
  return undefined;
}

function arrayBranch(schema: unknown): Json | undefined {
  const resolved = deref(schema);
  if (resolved.type === "array") {
    return resolved;
  }
  return ((resolved.anyOf ?? []) as unknown[]).map(deref).find((branch) => branch.type === "array");
}

function coerce(text: string, schema: unknown): unknown {
  const type = scalarType(schema);
  if (type === "integer" || type === "number") {
    return Number(text);
  }
  if (type === "boolean") {
    return text === "true" ? true : text === "false" ? false : text;
  }
  return text;
}

function findOperation(method: string, pathname: string) {
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    const operation = match === null ? undefined : OPENAPI.paths[route.template][method.toLowerCase()];
    if (match === null || !isRecord(operation)) {
      continue;
    }
    const values = Object.fromEntries(
      route.names.map((name, index) => [name, decodeURIComponent(match[index + 1] as string)]),
    );
    return { template: route.template, operation, values };
  }
  return null;
}

function formProblems(label: string, schema: unknown, entries: Array<[string, FormValue]>): string[] {
  const resolved = deref(schema);
  const properties = isRecord(resolved.properties) ? resolved.properties : {};
  const names = entries.map(([name]) => name);
  const problems: string[] = [];
  for (const name of (resolved.required ?? []) as string[]) {
    if (!names.includes(name)) {
      problems.push(`${label} form lacks the required field ${name}`);
    }
  }
  if (new Set(names).size !== names.length) {
    problems.push(`${label} form repeats a field: ${names.join(", ")}`);
  }
  for (const [name, value] of entries) {
    const property = properties[name];
    if (!isRecord(property)) {
      problems.push(`${label} form sends the undeclared field ${name}`);
    } else if (typeof value === "string") {
      problems.push(...schemaIssues(property, value).map((issue) => `${label} form ${name} ${issue}`));
    } else if (!("contentMediaType" in deref(property)) && deref(property).format !== "binary") {
      problems.push(`${label} form ${name} is a file but the field is not binary`);
    }
  }
  return problems;
}

function bodyProblems(label: string, operation: Json, request: Captured): string[] {
  if (operation.requestBody === undefined) {
    return request.hasBody ? [`${label} sends a body the operation does not take`] : [];
  }
  const requestBody = deref(operation.requestBody);
  if (!request.hasBody) {
    return requestBody.required === true ? [`${label} sends no body although one is required`] : [];
  }
  const content = isRecord(requestBody.content) ? requestBody.content : {};
  if (request.form !== undefined) {
    const media = content["multipart/form-data"];
    return isRecord(media)
      ? formProblems(label, media.schema, request.form)
      : [`${label} sends multipart data the operation does not take`];
  }
  const media = content["application/json"];
  if (!isRecord(media)) {
    return [`${label} sends JSON the operation does not take`];
  }
  const problems: string[] = [];
  if (!request.contentType.startsWith("application/json")) {
    problems.push(`${label} sends JSON as ${request.contentType || "no content type"}`);
  }
  problems.push(...schemaIssues(media.schema, request.json).map((issue) => `${label} body ${issue}`));
  problems.push(...unknownKeys(media.schema, request.json).map((key) => `${label} body sends the undeclared key ${key}`));
  return problems;
}

function requestProblems(request: Captured): string[] {
  const found = findOperation(request.method, request.url.pathname);
  if (found === null) {
    return [`${request.method} ${request.url.pathname} is not an operation of api/openapi.json`];
  }
  const { template, operation, values } = found;
  const label = `${request.method} ${template}`;
  const parameters = [...(OPENAPI.paths[template].parameters ?? []), ...(operation.parameters ?? [])].map(deref);
  const problems: string[] = [];
  for (const parameter of parameters.filter((entry) => entry.in === "path")) {
    const text = values[parameter.name];
    if (text === undefined) {
      problems.push(`${label} path parameter ${parameter.name} is not in the template`);
      continue;
    }
    problems.push(...schemaIssues(parameter.schema, coerce(text, parameter.schema)).map((issue) => `${label} path ${parameter.name} ${issue}`));
  }
  for (const name of new Set(request.url.searchParams.keys())) {
    const parameter = parameters.find((entry) => entry.in === "query" && entry.name === name);
    if (parameter === undefined) {
      problems.push(`${label} sends the undeclared query parameter ${name}`);
      continue;
    }
    const texts = request.url.searchParams.getAll(name);
    const array = arrayBranch(parameter.schema);
    if (array === undefined && texts.length > 1) {
      problems.push(`${label} repeats the scalar query parameter ${name}`);
    }
    const value = array === undefined ? coerce(texts[0] as string, parameter.schema) : texts.map((text) => coerce(text, array.items));
    problems.push(...schemaIssues(parameter.schema, value).map((issue) => `${label} query ${name} ${issue}`));
  }
  for (const parameter of parameters.filter((entry) => entry.in === "header")) {
    const text = request.headers.get(parameter.name);
    if (text === null) {
      if (parameter.required === true) {
        problems.push(`${label} lacks the required header ${parameter.name}`);
      }
      continue;
    }
    problems.push(...schemaIssues(parameter.schema, text).map((issue) => `${label} header ${parameter.name} ${issue}`));
  }
  for (const parameter of parameters.filter((entry) => entry.in === "query" && entry.required === true)) {
    if (!request.url.searchParams.has(parameter.name)) {
      problems.push(`${label} lacks the required query parameter ${parameter.name}`);
    }
  }
  problems.push(...bodyProblems(label, operation, request));
  return problems;
}

function responseProblems(request: Captured): string[] {
  const found = findOperation(request.method, request.url.pathname);
  if (found === null || request.responseJson === undefined) {
    return [];
  }
  const label = `${request.method} ${found.template} ${request.status}`;
  const responses = isRecord(found.operation.responses) ? found.operation.responses : {};
  if (responses[String(request.status)] === undefined) {
    return [`${label} is not a documented response`];
  }
  const content = deref(responses[String(request.status)]).content;
  const media = isRecord(content) ? (content["application/json"] ?? Object.values(content)[0]) : undefined;
  if (!isRecord(media) || !isRecord(media.schema)) {
    return [];
  }
  return schemaIssues(media.schema, request.responseJson).map((issue) => `${label} fixture ${issue}`);
}

async function describeRequest(request: Request): Promise<Captured> {
  const contentType = request.headers.get("content-type") ?? "";
  const base = { method: request.method, url: new URL(request.url), headers: request.headers, contentType, status: 0 };
  if (contentType.startsWith("multipart/form-data")) {
    return { ...base, hasBody: true, form: [...(await request.formData()).entries()] };
  }
  const text = await request.text();
  if (text.length === 0) {
    return { ...base, hasBody: false };
  }
  return { ...base, hasBody: true, json: JSON.parse(text) };
}

function capturingFetch(sink: Captured[], answer?: (request: Request) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const record = await describeRequest(request.clone());
    const response = answer === undefined ? await fetch(request) : answer(request);
    record.status = response.status;
    if ((response.headers.get("content-type") ?? "").includes("json")) {
      record.responseJson = await response
        .clone()
        .json()
        .catch(() => undefined);
    }
    sink.push(record);
    return response;
  }) as typeof fetch;
}

const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => uuidFor(prefix, index));
const FILES = Array.from({ length: 30 }, (_, index) => ({
  path: `${"src/".repeat(70)}file-${String(index).padStart(2, "0")}.ts`.slice(0, 300),
  lines: "1234567-7654321",
}));

const SCENARIOS: Array<[string, string, Json]> = [
  ["whoami", "whoami", {}],
  ["list_targets with defaults", "list_targets", {}],
  ["list_targets with every filter", "list_targets", { query: "q".repeat(200), include_archived: true, limit: 200 }],
  ["get_target", "get_target", { target_id: IDS.target }],
  ["issue_prompt discovery", "issue_prompt", { target_id: IDS.target, template: "discovery" }],
  ["issue_prompt fixup", "issue_prompt", { target_id: IDS.target, template: "fixup", params: { bundle_id: IDS.bundle } }],
  ["issue_prompt explain", "issue_prompt", { target_id: IDS.target, template: "explain", params: { finding_id: IDS.finding } }],
  ["issue_prompt author items", "issue_prompt", { target_id: IDS.target, template: "author", params: { proposal_item_ids: ids("1000000a", 50) } }],
  ["issue_prompt author cells", "issue_prompt", { target_id: IDS.target, template: "author", params: { cell_ids: ids("2000000a", 50) } }],
  ["issue_prompt propose", "issue_prompt", { target_id: IDS.target, template: "propose" }],
  [
    "issue_prompt propose with focus",
    "issue_prompt",
    { target_id: IDS.target, template: "propose", params: { focus: Array.from({ length: 20 }, () => "f".repeat(120)), since_commit: "0123456789abcdef0123456789abcdef01234567" } },
  ],
  ["issue_prompt mutants", "issue_prompt", { target_id: IDS.target, template: "mutants", params: { invariant_ids: Array.from({ length: 50 }, (_, index) => `invariant_${index}`) } }],
  ["issue_prompt hooks", "issue_prompt", { target_id: IDS.target, template: "hooks", params: { bundle_id: IDS.bundle } }],
  ["validate_bundle without a target", "validate_bundle", { path: "BUNDLE" }],
  ["validate_bundle with a target", "validate_bundle", { path: "BUNDLE", target_id: IDS.target }],
  ["upload_bundle without a note", "upload_bundle", { path: "BUNDLE" }],
  ["upload_bundle with a note and a target", "upload_bundle", { path: "BUNDLE", note: "n".repeat(500), target_id: IDS.target }],
  ["get_bundle", "get_bundle", { bundle_id: IDS.bundle }],
  ["get_bundle against another", "get_bundle", { bundle_id: IDS.bundle, against: uuidFor("3000000a", 1) }],
  ["get_environment", "get_environment", { target_id: IDS.target }],
  [
    "set_environment",
    "set_environment",
    {
      target_id: IDS.target,
      values: { ["N".repeat(200)]: "v".repeat(65_536), GRAPHQL_URL: "http://localhost:8521" },
      clear: Array.from({ length: 200 }, (_, index) => `NAME_${index}`),
    },
  ],
  ["set_environment clear only", "set_environment", { target_id: IDS.target, clear: ["STAFF_TOKEN"] }],
  ["run_health_checks of every interface", "run_health_checks", { target_id: IDS.target }],
  ["run_health_checks of some interfaces", "run_health_checks", { target_id: IDS.target, interface_ids: Array.from({ length: 100 }, (_, index) => `interface_${index}`) }],
  ["start_run of a saved plan", "start_run", { plan_id: IDS.plan, reset_seed: true, max_concurrency: 64 }],
  ["start_run of a subset", "start_run", { target_id: IDS.target, scenario_ids: ids("6000000a", 50) }],
  ["start_run of one scenario with a seed reset", "start_run", { target_id: IDS.target, scenario_ids: [IDS.scenario], reset_seed: true }],
  [
    "start_run of an inline plan",
    "start_run",
    { plan: { target_id: IDS.target, saved: false, selection: { interface_mode: "both", depth: "smoke", k: 1, roles: ["all"] } } },
  ],
  ["wait_run", "wait_run", { run_id: IDS.run, timeout_s: 1800 }],
  ["get_run with defaults", "get_run", { run_id: IDS.run }],
  ["get_run of what did not pass", "get_run", { run_id: IDS.run, limit: 200, only_not_passing: true }],
  ["get_step", "get_step", { step_id: IDS.step }],
  ["run_diff", "run_diff", { run_id: IDS.run }],
  ["run_diff against a run", "run_diff", { run_id: IDS.run, against: uuidFor("4000000a", 1) }],
  ["cancel_run", "cancel_run", { run_id: IDS.run }],
  ["list_findings single filters", "list_findings", { target_id: IDS.target, status: "new", severity: "high" }],
  [
    "list_findings every filter value",
    "list_findings",
    {
      target_id: IDS.target,
      status: ["new", "triaged", "in_fix", "verifying", "resolved", "known_gap", "dismissed"],
      severity: ["critical", "high", "medium", "low", "info"],
      limit: 200,
    },
  ],
  ["get_finding", "get_finding", { finding_id: IDS.finding }],
  ["add_explanation text only", "add_explanation", { finding_id: IDS.finding, text: "The refund path rounds twice." }],
  [
    "add_explanation at every bound",
    "add_explanation",
    {
      finding_id: IDS.finding,
      text: "t".repeat(20_000),
      structured: {
        opinion: "app_bug",
        root_cause: "r".repeat(2000),
        files: FILES,
        commit: "0123456789abcdef0123456789abcdef01234567",
        fix_branch: `fix/${"b".repeat(196)}`,
        confidence: "high",
      },
    },
  ],
  ["move_finding to triaged", "move_finding", { finding_id: IDS.finding, status: "triaged" }],
  ["move_finding to known_gap", "move_finding", { finding_id: IDS.finding, status: "known_gap", known_gap_reason: "k".repeat(500) }],
  ["get_proposal when there is none", "get_proposal", { target_id: IDS.target }],
  ["put_proposal", "put_proposal", { path: "BUNDLE", target_id: IDS.target }],
  ["update_proposal_item tick", "update_proposal_item", { item_id: uuidFor("1000000a", 1), status: "selected" }],
  ["update_proposal_item decline with a note", "update_proposal_item", { item_id: uuidFor("1000000a", 1), status: "declined", note: "d".repeat(300) }],
  ["plan_from_proposal of the selection", "plan_from_proposal", { target_id: IDS.target }],
  ["plan_from_proposal of named items", "plan_from_proposal", { target_id: IDS.target, name: "p".repeat(120), item_ids: ids("1000000a", 200) }],
  ["get_coverage", "get_coverage", { target_id: IDS.target }],
  [
    "get_coverage every filter value",
    "get_coverage",
    { target_id: IDS.target, status: ["empty", "generated", "covered", "needs_author", "blocked"], area: ["Billing", "Auth"], offset: 1 },
  ],
  ["validate_scenario", "validate_scenario", { yaml: "id: a\ntitle: A\n", target_id: IDS.target }],
  [
    "list_scenarios every status",
    "list_scenarios",
    { target_id: IDS.target, status: ["draft", "validating", "invalid", "in_review", "accepted", "rejected", "quarantined", "retired"], limit: 200 },
  ],
];

let bundleRoot: string;

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());

beforeEach(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "tessa-contract-"));
  const folder = join(bundleRoot, "tessa");
  await mkdir(join(folder, "scenarios"), { recursive: true });
  await writeFile(join(folder, "manifest.yaml"), `target_token: ${TARGET_TOKEN}\napp:\n  name: Demo\n`);
  await writeFile(join(folder, "scenarios", "a.yaml"), "id: a\n");
  await writeFile(join(folder, "proposal.yaml"), stringify(proposalDoc(2)));
});

afterEach(async () => {
  await rm(bundleRoot, { recursive: true, force: true });
});

async function runScenario(tool: string, args: Json) {
  const sink: Captured[] = [];
  const harness = createHarness({ fetchImpl: capturingFetch(sink) });
  const resolved = JSON.parse(JSON.stringify(args).replace('"BUNDLE"', JSON.stringify(bundleRoot))) as Json;
  const result = await harness.call(tool, resolved);
  return { sink, result };
}

describe("every REST call of every tool is an operation of api/openapi.json", () => {
  it("exercises every tool that talks to the API", () => {
    const exercised = new Set(SCENARIOS.map(([, tool]) => tool));
    const remote = TOOLS.map((tool) => tool.name).filter((name) => !LOCAL_TOOLS.has(name));
    expect([...exercised].sort()).toEqual([...remote].sort());
  });

  it.each(SCENARIOS)("%s", async (_label, tool, args) => {
    const { sink, result } = await runScenario(tool, args);
    expect(result.isError, result.text.slice(0, 2000)).toBe(false);
    expect(sink.length).toBeGreaterThan(0);
    expect(sink.flatMap(requestProblems)).toEqual([]);
    expect(result.text).not.toContain(TOKEN);
  });

  it("the agent session calls of the server match too", async () => {
    const sink: Captured[] = [];
    const harness = createHarness({ fetchImpl: capturingFetch(sink) });
    await harness.session.start();
    await harness.call("get_target", { target_id: IDS.target });
    await harness.session.end();
    const sessionCalls = sink.filter((request) => request.url.pathname.startsWith("/api/v1/agent-sessions"));
    expect(sessionCalls.map((request) => request.method)).toEqual(["POST", "PATCH", "PATCH"]);
    expect(sink.flatMap(requestProblems)).toEqual([]);
  });

  it("the inbox subscribes to feeds that exist with a target filter", async () => {
    const sink: Captured[] = [];
    const inbox = new Inbox({
      baseUrl: BASE_URL,
      token: TOKEN,
      store: new MemoryInboxStore(),
      redactor: new Redactor(),
      clock: createFakeClock(),
      random: () => 0.5,
      log: () => undefined,
      fetchImpl: capturingFetch(sink, () => new Response(null, { status: 404 })),
    });
    inbox.watch(IDS.target);
    const deadline = Date.now() + 5000;
    while (sink.length < FEEDS.length && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    await inbox.stop();
    expect(sink.map((request) => request.url.pathname).sort()).toEqual(FEEDS.map((feed) => `/api/v1/feeds/${feed}`).sort());
    expect(sink.flatMap(requestProblems)).toEqual([]);
  });
});

const EDGES: Array<[string, string, Json]> = [
  ["issue_prompt fixup without a bundle", "issue_prompt", { target_id: IDS.target, template: "fixup" }],
  ["issue_prompt explain without a finding", "issue_prompt", { target_id: IDS.target, template: "explain" }],
  ["issue_prompt discovery with params of another template", "issue_prompt", { target_id: IDS.target, template: "discovery", params: { focus: ["Billing"] } }],
  ["issue_prompt discovery with its own params", "issue_prompt", { target_id: IDS.target, template: "discovery", params: { hint_ids: ["h1"], template_version: 1 } }],
  ["issue_prompt fixup with params of another template", "issue_prompt", { target_id: IDS.target, template: "fixup", params: { bundle_id: IDS.bundle, finding_id: IDS.finding } }],
  ...(
    [
      ["a Windows path", { files: [{ path: "src\\billing\\refunds.py", lines: "12-40" }] }],
      ["a path of 301 characters", { files: [{ path: `${"a".repeat(298)}.py` }] }],
      ["a line number of eight digits", { files: [{ path: "src/refunds.py", lines: "12345678" }] }],
      ["an upper case commit", { commit: "ABCDEF1" }],
      ["a commit that is not hex", { commit: "release-1" }],
      ["a branch with a space", { fix_branch: "fix refunds" }],
    ] as Array<[string, Json]>
  ).map(([label, fields]): [string, string, Json] => [
    `add_explanation with ${label}`,
    "add_explanation",
    {
      finding_id: IDS.finding,
      text: "The refund path rounds twice.",
      structured: { opinion: "app_bug", root_cause: "Rounds twice", files: [], confidence: "medium", ...fields },
    },
  ]),
];

describe("what a tool accepts, the API accepts", () => {
  it.each(EDGES)("%s is refused before any request or sent in a shape the API takes", async (_label, tool, args) => {
    const { sink, result } = await runScenario(tool, args);
    if (result.isError) {
      expect(result.body.error.code).toBe("invalid_arguments");
      expect(sink).toHaveLength(0);
    } else {
      expect(sink.flatMap(requestProblems)).toEqual([]);
    }
  });

  it.each([
    ["an inverted line range", { files: [{ path: "src/refunds.py", lines: "40-12" }] }],
    ["a home path", { files: [{ path: "~/src/refunds.py" }] }],
    ["a path with a control character", { files: [{ path: "src/re\u0007funds.py" }] }],
    ["a parent folder behind a Windows separator", { files: [{ path: "src\\..\\secrets.py" }] }],
    ["a blank root cause", { root_cause: "   " }],
  ] as Array<[string, Json]>)("add_explanation refuses %s, which the API refuses too", async (_label, fields) => {
    const { sink, result } = await runScenario("add_explanation", {
      finding_id: IDS.finding,
      text: "The refund path rounds twice.",
      structured: { opinion: "app_bug", root_cause: "Rounds twice", files: [], confidence: "medium", ...fields },
    });
    expect(result.body.error.code).toBe("invalid_arguments");
    expect(sink).toHaveLength(0);
  });

  it("add_explanation caps the text at the default TESSA_EXPLANATION_MAX_CHARS of the API", async () => {
    const example = readFileSync(resolve(here, "..", "..", "..", "api", ".env.example"), "utf8");
    expect(Number(/^TESSA_EXPLANATION_MAX_CHARS=(\d+)\s*$/m.exec(example)?.[1])).toBe(EXPLANATION_TEXT_MAX_CHARS);
    const description = TOOLS.find((tool) => tool.name === "add_explanation")?.description ?? "";
    expect(description).toContain("TESSA_EXPLANATION_MAX_CHARS");
    const atLimit = await runScenario("add_explanation", { finding_id: IDS.finding, text: "t".repeat(EXPLANATION_TEXT_MAX_CHARS) });
    expect(atLimit.result.isError).toBe(false);
    expect(atLimit.sink).toHaveLength(1);
    const over = await runScenario("add_explanation", { finding_id: IDS.finding, text: "t".repeat(EXPLANATION_TEXT_MAX_CHARS + 1) });
    expect(over.result.body.error.code).toBe("invalid_arguments");
    expect(over.sink).toHaveLength(0);
  });

  it("add_explanation refuses a blank text, which the API refuses too", async () => {
    const { sink, result } = await runScenario("add_explanation", { finding_id: IDS.finding, text: " \n " });
    expect(result.body.error.code).toBe("invalid_arguments");
    expect(sink).toHaveLength(0);
  });

  it("add_explanation sends a Windows path with forward slashes", async () => {
    const { sink } = await runScenario("add_explanation", {
      finding_id: IDS.finding,
      text: "The refund path rounds twice.",
      structured: { opinion: "app_bug", root_cause: "Rounds twice", files: [{ path: "src\\billing\\refunds.py" }], confidence: "medium" },
    });
    expect((sink[0]?.json as Json).structured.files).toEqual([{ path: "src/billing/refunds.py" }]);
  });
});

describe("the contract checker", () => {
  const request = (method: string, url: string, extra: Partial<Captured> = {}): Captured => ({
    method,
    url: new URL(url, BASE_URL),
    headers: new Headers(),
    contentType: "",
    hasBody: false,
    status: 0,
    ...extra,
  });
  const json = (body: unknown, headers: Record<string, string> = {}): Partial<Captured> => ({
    hasBody: true,
    json: body,
    contentType: "application/json",
    headers: new Headers(headers),
  });

  it("refuses a path, a method and a query parameter the API does not have", () => {
    expect(requestProblems(request("GET", "/api/v1/no-such-thing"))).toHaveLength(1);
    expect(requestProblems(request("DELETE", "/api/v1/users/me"))).toHaveLength(1);
    expect(requestProblems(request("GET", "/api/v1/findings?colour=red")).join()).toContain("undeclared query parameter colour");
  });

  it("refuses a bad path parameter, a value outside an enum and a repeated scalar", () => {
    expect(requestProblems(request("GET", "/api/v1/runs/not-a-uuid")).join()).toContain("path run_id");
    expect(requestProblems(request("GET", `/api/v1/findings?status=open`)).join()).toContain("query status");
    expect(requestProblems(request("GET", `/api/v1/findings?target_id=${IDS.target}&target_id=${IDS.target}`)).join()).toContain("repeats the scalar");
    expect(requestProblems(request("GET", "/api/v1/coverage")).join()).toContain("required query parameter target_id");
  });

  it("refuses a missing idempotency key, an undeclared body key, a missing required key and a body nobody takes", () => {
    const body = { plan_id: IDS.plan, colour: "red" };
    const problems = requestProblems(request("POST", "/api/v1/runs", json(body))).join("\n");
    expect(problems).toContain("required header Idempotency-Key");
    expect(problems).toContain("undeclared key colour");
    expect(requestProblems(request("PUT", `/api/v1/targets/${IDS.target}/proposal`, json({}))).join()).toContain("required key yaml");
    expect(requestProblems(request("GET", "/api/v1/users/me", json({ a: 1 }))).join()).toContain("does not take");
  });

  it("follows the template discriminator of a prompt issue", () => {
    const problems = requestProblems(
      request("POST", `/api/v1/targets/${IDS.target}/prompt-issues`, json({ template_name: "hooks" }, { "Idempotency-Key": "key-0001" })),
    );
    expect(problems.join()).toContain("required key bundle_id");
    const unknown = requestProblems(
      request("POST", `/api/v1/targets/${IDS.target}/prompt-issues`, json({ template_name: "nope" }, { "Idempotency-Key": "key-0001" })),
    );
    expect(unknown.join()).toContain("no template_name branch");
  });

  it("refuses an undeclared multipart field and a missing file", () => {
    const form: Array<[string, FormValue]> = [["target_id", IDS.target], ["colour", "red"]];
    const problems = requestProblems(
      request("POST", "/api/v1/bundles/validate", { hasBody: true, form, contentType: "multipart/form-data; boundary=x" }),
    ).join("\n");
    expect(problems).toContain("required field file");
    expect(problems).toContain("undeclared field colour");
  });
});

describe("the API doubles answer in the shapes of api/openapi.json", () => {
  it.each(SCENARIOS)("%s", async (_label, tool, args) => {
    const { sink } = await runScenario(tool, args);
    expect(sink.flatMap(responseProblems)).toEqual([]);
  });
});
