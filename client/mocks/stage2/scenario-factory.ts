import type { CatalogItem } from "../factories/catalog";
import { slugify } from "../factories/targets";
import type { BundleRecord } from "../stage1/store";
import { toYaml } from "../stage1/yaml";
import type { Scenario } from "@/lib/api/types";
import type { ExpandedCell } from "./expand";
import { stableId } from "./ids";

type JsonRecord = Record<string, unknown>;
type CatalogExample = CatalogItem["examples"][number];

const SCENARIO_TIMEOUT_SECONDS = 120;
const MAX_EXAMPLE_STEPS = 2;
const LATENCY_BUDGET_MS = 3000;
const SECOND_MS = 1000;

export interface ScenarioStepDoc extends JsonRecord {
  adapter: "http" | "sse" | "browser";
  label: string;
}

export interface ScenarioDoc extends JsonRecord {
  schema_version: 1;
  title: string;
  feature_id: string | null;
  family: string;
  role: string;
  interface_id: string;
  timeout_seconds: number;
  cell: { role: string; interface_id: string } | null;
  synthetic: boolean;
  steps: ScenarioStepDoc[];
}

export interface SmokeScenarioInput {
  targetId: string;
  record: BundleRecord;
  feature: CatalogItem;
  cell: ExpandedCell;
  createdAt: string;
}

function joinPath(basePath: string, path: string): string {
  const base = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  const tail = path.startsWith("/") ? path : `/${path}`;
  return tail.startsWith(`${base}/`) ? tail : `${base}${tail}`;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function describeFeature(feature: CatalogItem): string {
  return feature.description.replace(/\.$/, "");
}

export function toolNameOf(feature: CatalogItem): string {
  return feature.feature_id.split(".").at(-1) ?? feature.feature_id;
}

function examplesFor(feature: CatalogItem, kind: "ask" | "request"): CatalogExample[] {
  const matching = feature.examples.filter((example) =>
    kind === "ask"
      ? typeof example.ask === "string" && example.ask !== ""
      : asRecord(example.request) !== null,
  );
  return matching.slice(0, MAX_EXAMPLE_STEPS);
}

function chatStep(
  feature: CatalogItem,
  example: CatalogExample | null,
  basePath: string,
): ScenarioStepDoc {
  const ask = example?.ask ?? `Please help with this: ${describeFeature(feature)}`;
  const expectation: JsonRecord = {
    status: 200,
    events: { include: ["done"] },
    free_text: example?.expected ?? describeFeature(feature),
    latency: { max_ms: LATENCY_BUDGET_MS * 3 },
  };
  if (feature.kind === "read") {
    expectation.tools = { include: [toolNameOf(feature)] };
  }
  if (feature.kind === "write") {
    expectation.cards = { min_count: 1, include: [{ kind: "confirmation" }] };
  }
  return {
    label: ask.length > 60 ? `${ask.slice(0, 57)}...` : ask,
    adapter: "sse",
    ask,
    request: { method: "POST", path: basePath, body: { message: ask } },
    expect: expectation,
  };
}

function httpStep(
  feature: CatalogItem,
  example: CatalogExample | null,
  basePath: string,
): ScenarioStepDoc {
  const request = asRecord(example?.request ?? null) ?? {
    method: "GET",
    path: "/",
  };
  const method = typeof request.method === "string" ? request.method : "GET";
  const path = typeof request.path === "string" ? request.path : "/";
  const requestDoc: JsonRecord = { method, path: joinPath(basePath, path) };
  const query = asRecord(request.query);
  if (query !== null) {
    requestDoc.query = query;
  }
  const headers = asRecord(request.headers);
  if (headers !== null) {
    requestDoc.headers = headers;
  }
  if (request.body !== undefined) {
    requestDoc.body = request.body;
  }
  const expectation: JsonRecord = {
    status: method === "POST" && feature.kind === "write" ? 201 : 200,
    internal_ids: true,
    latency: { max_ms: LATENCY_BUDGET_MS },
    free_text: example?.expected ?? describeFeature(feature),
  };
  if (/^list|summar/i.test(feature.description)) {
    expectation.fields = [{ path: "items", min_length: 1 }];
  }
  return {
    label: `${method} ${requestDoc.path as string}`,
    adapter: "http",
    request: requestDoc,
    expect: expectation,
  };
}

function loginSteps(role: string): ScenarioStepDoc[] {
  return [
    {
      label: "Open the sign-in page",
      adapter: "browser",
      action: "goto",
      url: "/login",
      expect: { dom_state: { url: "/login", text_contains: ["Sign in"] } },
    },
    {
      label: `Fill the ${role} email`,
      adapter: "browser",
      action: "fill",
      target: { role: "textbox", name: "Email" },
      value: "${GRACIE_GUEST_EMAIL}",
      expect: {},
    },
    {
      label: `Fill the ${role} password`,
      adapter: "browser",
      action: "fill",
      target: { role: "textbox", name: "Password" },
      value: "${GRACIE_GUEST_PASSWORD}",
      expect: {},
    },
    {
      label: "Press Sign in",
      adapter: "browser",
      action: "click",
      target: { role: "button", name: "Sign in" },
      expect: { dom_state: { url: "/" }, console: { fail_on: ["error"] } },
    },
  ];
}

function browserSteps(feature: CatalogItem, role: string): ScenarioStepDoc[] {
  const example = feature.examples.find((candidate) => candidate.ask) ?? feature.examples[0];
  const ask = example?.ask ?? describeFeature(feature);
  return [
    ...loginSteps(role),
    {
      label: `Type: ${ask.length > 40 ? `${ask.slice(0, 37)}...` : ask}`,
      adapter: "browser",
      action: "fill",
      target: { role: "textbox", name: "Message" },
      value: ask,
      expect: {},
    },
    {
      label: "Press Send",
      adapter: "browser",
      action: "click",
      target: { role: "button", name: "Send" },
      expect: {
        dom_state: {
          text_contains: [feature.area],
          visible: [{ role: "log", name: "Conversation" }],
        },
        console: { fail_on: ["error"] },
        free_text: example?.expected ?? describeFeature(feature),
      },
    },
  ];
}

export function buildStepDocs(
  feature: CatalogItem,
  cell: Pick<ExpandedCell, "interfaceKind" | "role">,
  basePath: string,
): ScenarioStepDoc[] {
  if (cell.interfaceKind === "browser") {
    return browserSteps(feature, cell.role);
  }
  if (cell.interfaceKind === "sse") {
    const asks = examplesFor(feature, "ask");
    if (asks.length > 0) {
      return asks.map((example) => chatStep(feature, example, basePath));
    }
    const requests = examplesFor(feature, "request");
    if (requests.length > 0) {
      return requests.map((example) => httpStep(feature, example, basePath));
    }
    return [chatStep(feature, null, basePath)];
  }
  const requests = examplesFor(feature, "request");
  return requests.length > 0
    ? requests.map((example) => httpStep(feature, example, basePath))
    : [httpStep(feature, null, basePath)];
}

export function titleOf(feature: CatalogItem, cell: Pick<ExpandedCell, "role" | "interfaceId">) {
  return `${describeFeature(feature)} (${cell.role}, ${cell.interfaceId})`;
}

export function renderScenarioYaml(doc: JsonRecord): string {
  return toYaml(doc);
}

export function buildSmokeScenario(input: SmokeScenarioInput): Scenario {
  const { targetId, record, feature, cell, createdAt } = input;
  const basePath =
    record.interfaces.find((entry) => entry.id === cell.interfaceId)?.base_path ?? "/";
  const doc: ScenarioDoc = {
    schema_version: 1,
    title: titleOf(feature, cell),
    feature_id: feature.feature_id,
    family: slugify(feature.area),
    role: cell.role,
    interface_id: cell.interfaceId,
    timeout_seconds: SCENARIO_TIMEOUT_SECONDS,
    cell: { role: cell.role, interface_id: cell.interfaceId },
    synthetic: false,
    steps: buildStepDocs(feature, cell, basePath),
  };
  return {
    id: stableId("scenario", targetId, cell.key),
    target_id: targetId,
    bundle_id: record.bundle.id,
    feature_id: feature.feature_id,
    cell_id: stableId("cell", targetId, cell.key),
    title: doc.title,
    family: doc.family,
    origin: "bundle_example",
    status: "accepted",
    version: 1,
    yaml: renderScenarioYaml(doc),
    parsed: JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    synthetic: false,
    validation: { valid: true, errors: [], warnings: [] },
    provenance: { source: "bundle_example", bundle_version: record.bundle.version },
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function plusSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * SECOND_MS).toISOString();
}
