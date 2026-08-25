import type { CatalogItem } from "../factories/catalog";
import { stableId, stableInt } from "../stage2/ids";
import type { ScenarioStepDoc } from "../stage2/scenario-factory";
import type { ArtifactSpec } from "../stage2/types";
import type {
  AdapterKind,
  AnyStepRequest,
  AnyStepResponse,
  BrowserAction,
  BrowserStepRequest,
  BrowserStepResponse,
  DbCheck,
  EvidenceBlock,
  GoldPoint,
  HttpStepRequest,
  HttpStepResponse,
  JudgeResult,
  ProbeResult,
  SseStepEvent,
  SseStepRequest,
  SseStepResponse,
  Step,
  StepTool,
  Tier0Failure,
  Tier0Result,
  Verdict,
} from "@/lib/api/types";

export interface StepContent {
  adapter: AdapterKind;
  label: string;
  request: AnyStepRequest | null;
  response: AnyStepResponse | null;
  response_truncated: boolean;
  payload_purged: boolean;
  ask: string | null;
  answer: string | null;
  tools: StepTool[];
  cards: Record<string, unknown>[];
  latency_ms: number;
  cost_usd: number;
  tier0: Tier0Result;
  ok: boolean | null;
  artifacts: ArtifactSpec[];
  verdict: Verdict | null;
  gold_points?: GoldPoint[];
  db_checks?: DbCheck[];
  probes?: ProbeResult[];
  judge?: JudgeResult | null;
  evidence?: EvidenceBlock | null;
}

export function generatedStepPayloads(content: StepContent): Pick<Step, "request" | "response"> {
  return {
    request: content.request as Step["request"],
    response: content.response as Step["response"],
  };
}

export interface StepContentInput {
  doc: ScenarioStepDoc;
  feature: CatalogItem | null;
  role: string;
  interfaceId: string;
  baseUrl: string;
  seed: string;
  failing: boolean;
  recordingAndTrace: boolean;
}

type JsonRecord = Record<string, unknown>;

const TOKEN_PLACEHOLDER = "Bearer ${GRACIE_ADMIN_TOKEN}";
const BROWSER_ACTIONS: Readonly<Record<string, BrowserAction>> = {
  goto: "navigate",
  click: "click",
  fill: "type",
  press: "press",
  select: "click",
  check: "click",
  hover: "click",
  wait_for: "wait",
};
const SSE_TOKEN_SIZE = 4;

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function passed(): Tier0Result {
  return { passed: true, failures: [] };
}

function failed(failures: Tier0Failure[]): Tier0Result {
  return { passed: false, failures };
}

function describeTarget(value: unknown): string | null {
  const target = asRecord(value);
  const name = target.name;
  const role = target.role;
  const selector = target.selector;
  if (typeof role === "string" && typeof name === "string") {
    return `${role} "${name}"`;
  }
  if (typeof selector === "string") {
    return selector;
  }
  return typeof name === "string" ? name : null;
}

function listBody(feature: CatalogItem | null, seed: string): JsonRecord {
  const total = stableInt(2, 6, seed, "total");
  return {
    items: Array.from({ length: Math.min(total, 3) }, (_, index) => ({
      id: stableId("row", seed, index),
      room: String(20003 + index * 8),
      status: index === 0 ? "open" : "waiting",
      title: `${feature?.area ?? "Item"} entry ${index + 1}`,
    })),
    total,
  };
}

function methodBody(method: string, feature: CatalogItem | null, seed: string): JsonRecord {
  if (method === "POST" && feature?.kind === "auth") {
    return { token: "[redacted]", expires_in: 3600 };
  }
  if (method === "POST") {
    return { id: stableId("created", seed), status: "open" };
  }
  if (method === "PATCH") {
    return { id: stableId("updated", seed), updated: true };
  }
  return listBody(feature, seed);
}

function httpContent(input: StepContentInput): StepContent {
  const { doc, feature, seed, failing } = input;
  const request = asRecord(doc.request);
  const method = asText(request.method, "GET");
  const path = asText(request.path, "/");
  const status = failing ? 500 : method === "POST" && feature?.kind === "write" ? 201 : 200;
  const requestPayload: HttpStepRequest = {
    kind: "http",
    method,
    url: `${input.baseUrl}${path}`,
    headers: { Authorization: TOKEN_PLACEHOLDER, Accept: "application/json" },
    query: Object.keys(asRecord(request.query)).length > 0 ? asRecord(request.query) : null,
    body: request.body ?? null,
  };
  const body: unknown = failing
    ? { error: { code: "internal_error", message: "Internal server error" } }
    : methodBody(method, feature, seed);
  const response: HttpStepResponse = {
    kind: "http",
    status,
    headers: { "content-type": "application/json", "x-request-id": stableId("request", seed) },
    body,
    body_text: null,
  };
  const latency = stableInt(40, 480, seed, "latency");
  return {
    adapter: "http",
    label: doc.label,
    request: requestPayload,
    response,
    response_truncated: false,
    payload_purged: false,
    ask: null,
    answer: null,
    tools: [],
    cards: [],
    latency_ms: latency,
    cost_usd: 0,
    tier0: failing
      ? failed([
          {
            check: "status",
            message: `Expected status ${method === "POST" ? 201 : 200}, got ${status}`,
            expected: method === "POST" ? 201 : 200,
            actual: status,
          },
        ])
      : passed(),
    ok: true,
    artifacts: [],
    verdict: null,
  };
}

function answerFor(feature: CatalogItem | null, ask: string, failing: boolean): string {
  if (failing) {
    return "Sorry, I could not find anything about that right now. Please try again later.";
  }
  switch (feature?.kind) {
    case "write":
      return "I can do that. Nothing has been saved yet: press Confirm to apply the change.";
    case "stream":
      return "Breakfast is served from 6:30 to 10:30 in the Garden Room.";
    case "read":
      return "I found 7 matching items. Rooms 20003, 20011 and 10407 have the most; the first three are listed below.";
    default:
      return `Here is the result for "${ask}".`;
  }
}

function cardsFor(feature: CatalogItem | null, failing: boolean): Record<string, unknown>[] {
  if (failing) {
    return [];
  }
  if (feature?.kind === "write") {
    return [{ kind: "confirmation", title: "Apply this change?", actions: ["Confirm", "Cancel"] }];
  }
  if (feature?.kind === "read") {
    return [
      {
        kind: "list",
        title: feature.area,
        rows: [
          { room: "20003", status: "open" },
          { room: "20011", status: "open" },
          { room: "10407", status: "waiting" },
        ],
      },
    ];
  }
  return [];
}

function toolsFor(feature: CatalogItem | null, failing: boolean): StepTool[] {
  if (feature === null || failing || feature.kind === "stream") {
    return [];
  }
  const name = feature.feature_id.split(".").at(-1) ?? feature.feature_id;
  return [
    {
      name: feature.kind === "write" ? `prepare_${name}` : name,
      args: { status: "open", limit: 20 },
      result_summary: feature.kind === "write" ? "confirmation card created" : "7 rows",
    },
  ];
}

function chunkText(text: string): string[] {
  const words = text.split(" ");
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += SSE_TOKEN_SIZE) {
    chunks.push(`${words.slice(index, index + SSE_TOKEN_SIZE).join(" ")} `);
  }
  return chunks;
}

function sseContent(input: StepContentInput): StepContent {
  const { doc, feature, seed, failing } = input;
  const request = asRecord(doc.request);
  const ask = asText(doc.ask, doc.label);
  const answer = answerFor(feature, ask, failing);
  const tools = toolsFor(feature, failing);
  const cards = cardsFor(feature, failing);
  let at = stableInt(180, 420, seed, "first");
  const events: SseStepEvent[] = [];
  for (const tool of tools) {
    events.push({
      event: "tool_call",
      data: JSON.stringify({ name: tool.name, args: tool.args }),
      at_ms: at,
    });
    at += 90;
  }
  for (const chunk of chunkText(answer)) {
    events.push({ event: "token", data: JSON.stringify({ text: chunk }), at_ms: at });
    at += stableInt(40, 90, seed, "token", at);
  }
  for (const card of cards) {
    events.push({ event: "card", data: JSON.stringify(card), at_ms: at });
    at += 30;
  }
  events.push({ event: "done", data: "{}", at_ms: at });
  const requestPayload: SseStepRequest = {
    kind: "sse",
    method: asText(request.method, "POST"),
    url: `${input.baseUrl}${asText(request.path, "/")}`,
    headers: {
      Authorization: TOKEN_PLACEHOLDER,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    query: null,
    body: request.body ?? { message: ask },
  };
  const response: SseStepResponse = { kind: "sse", status: 200, events, closed_by: "server" };
  const failures: Tier0Failure[] = failing
    ? [
        {
          check: "text_contains",
          message: "The answer does not mention the expected content",
          expected: "open",
          actual: answer,
        },
        ...(feature?.kind === "read"
          ? [
              {
                check: "tools" as const,
                message: "The expected tool was not called",
                expected: feature.feature_id.split(".").at(-1) ?? null,
                actual: [],
              },
            ]
          : []),
      ]
    : [];
  return {
    adapter: "sse",
    label: doc.label,
    request: requestPayload,
    response,
    response_truncated: false,
    payload_purged: false,
    ask,
    answer,
    tools,
    cards,
    latency_ms: at + stableInt(20, 120, seed, "tail"),
    cost_usd: 0,
    tier0: failing ? failed(failures) : passed(),
    ok: true,
    artifacts: [],
    verdict: null,
  };
}

function browserContent(input: StepContentInput): StepContent {
  const { doc, feature, seed, failing, recordingAndTrace } = input;
  const action = BROWSER_ACTIONS[asText(doc.action, "goto")] ?? "navigate";
  const domState = asRecord(asRecord(doc.expect).dom_state);
  const pathAfter = asText(domState.url, "/");
  const expectedTexts = Array.isArray(domState.text_contains)
    ? domState.text_contains.filter((text): text is string => typeof text === "string")
    : [];
  const requestPayload: BrowserStepRequest = {
    kind: "browser",
    action,
    target: describeTarget(doc.target),
    text: typeof doc.value === "string" ? doc.value : null,
    url: typeof doc.url === "string" ? `${input.baseUrl}${doc.url}` : null,
  };
  const textFound: Record<string, boolean> = {};
  for (const text of expectedTexts) {
    textFound[text] = !failing;
  }
  const response: BrowserStepResponse = {
    kind: "browser",
    url: `${input.baseUrl}${pathAfter}`,
    title: feature === null ? "Gracie" : `${feature.area} | Gracie`,
    text_excerpt: failing
      ? "Something went wrong. Please try again."
      : `Gracie ${feature?.area ?? ""} - ${asText(doc.label, "")}`.trim(),
    console: failing
      ? [{ level: "error", text: "Failed to load resource: 500 (Internal Server Error)" }]
      : [],
    dom_state: { text_found: textFound, elements: {} },
  };
  const artifacts: ArtifactSpec[] = [{ kind: "screenshot", fixture: "png", key: "shot" }];
  if (recordingAndTrace) {
    artifacts.push({ kind: "recording", fixture: "webm" }, { kind: "trace", fixture: "zip" });
  }
  return {
    adapter: "browser",
    label: doc.label,
    request: requestPayload,
    response,
    response_truncated: false,
    payload_purged: false,
    ask: null,
    answer: null,
    tools: [],
    cards: [],
    latency_ms: stableInt(120, 900, seed, "latency"),
    cost_usd: 0,
    tier0: failing
      ? failed([
          {
            check: "dom_state",
            message: "The page does not show the expected text",
            expected: expectedTexts[0] ?? "the expected text",
            actual: "Something went wrong. Please try again.",
          },
          {
            check: "console",
            message: "The console logged an error",
            expected: [],
            actual: ["Failed to load resource: 500 (Internal Server Error)"],
          },
        ])
      : passed(),
    ok: true,
    artifacts,
    verdict: null,
  };
}

export function buildStepContent(input: StepContentInput): StepContent {
  if (input.doc.adapter === "browser") {
    return browserContent(input);
  }
  return input.doc.adapter === "sse" ? sseContent(input) : httpContent(input);
}
