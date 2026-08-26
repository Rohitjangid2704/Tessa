import { createParser } from "eventsource-parser";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { STAGE_TWO_IDS } from "@/mocks/stage2/seed-ids";
import type { Plan, PlanCreate, PlanPreview, PlanSelection, Run, RunHandle } from "@/lib/api/types";
import { requestWsTicket, SocketProbe } from "./mock-api";
import { createStage1Client, errorOf, type Role, type Stage1Client } from "./stage1";
import { bearer, mintApiToken } from "./tokens";

export { errorOf, STAGE_ONE_IDS, STAGE_TWO_IDS };
export type { Role };

export const GRACIE_ID = STAGE_ONE_IDS.gracie;

export interface ClockControl {
  speed?: number;
  default_speed?: number;
  paused?: boolean;
  seed?: number;
  step_cost_usd?: number;
}

export type PlanBodyOverrides = Omit<Partial<PlanCreate>, "selection"> & {
  selection?: Partial<PlanSelection>;
};

export interface Stage2Control {
  state: () => Promise<Record<string, unknown>>;
  seed: (seed: "gracie" | "empty") => Promise<Response>;
  clock: (body: ClockControl) => Promise<Response>;
  advance: (body?: { ms?: number; until_idle?: boolean }) => Promise<Response>;
  settle: () => Promise<Response>;
  hold: (phase: string, runId?: string) => Promise<Response>;
  release: (body?: { phase?: string; run_id?: string }) => Promise<Response>;
  dropFeeds: () => Promise<Response>;
  productionTarget: (allowProduction?: boolean) => Promise<Response>;
  faults: (patch: Record<string, unknown>) => Promise<Response>;
}

export interface Stage2Client extends Stage1Client {
  control: Stage2Control;
  selection: (overrides?: Partial<PlanSelection>) => PlanSelection;
  planBody: (overrides?: PlanBodyOverrides) => PlanCreate;
  preview: (body: PlanCreate, role?: Role) => Promise<PlanPreview>;
  createPlan: (body: PlanCreate, role?: Role) => Promise<Plan>;
  startRun: (
    body: Record<string, unknown>,
    options?: { key?: string | null; role?: Role },
  ) => Promise<Response>;
  startInlineRun: (selection?: Partial<PlanSelection>, targetId?: string) => Promise<RunHandle>;
  getRun: (runId: string) => Promise<Run>;
  runToEnd: (runId: string) => Promise<Run>;
  waitForRun: (runId: string, predicate: (run: Run) => boolean, timeoutMs?: number) => Promise<Run>;
  getEvents: (runId: string) => Promise<Array<Record<string, unknown>>>;
  openRunSocket: (runId: string, lastSeq?: number) => Promise<SocketProbe>;
  openFeed: (query?: string, options?: FeedOptions) => Promise<FeedProbe>;
  feedUrl: (query?: string) => string;
}

export interface FeedOptions {
  token?: string | null;
  signal?: AbortSignal;
}

export interface FeedEnvelope {
  type: string;
  run_id: string | null;
  seq: number | null;
  ts: string;
  payload: Record<string, unknown>;
}

export interface FeedMessage {
  event: string | undefined;
  envelope: FeedEnvelope;
}

const DEFAULT_WAIT_MS = 8000;
const POLL_MS = 10;

export class FeedProbe {
  readonly messages: FeedMessage[] = [];
  comments = 0;
  ended = false;
  readonly status: number;
  readonly contentType: string | null;
  private readonly controller: AbortController;

  private constructor(status: number, contentType: string | null, controller: AbortController) {
    this.status = status;
    this.contentType = contentType;
    this.controller = controller;
  }

  static async open(url: string, token: string | null, signal?: AbortSignal): Promise<FeedProbe> {
    const controller = new AbortController();
    signal?.addEventListener("abort", () => controller.abort());
    const response = await fetch(url, {
      headers: { Accept: "text/event-stream", ...(token === null ? {} : bearer(token)) },
      signal: controller.signal,
    });
    const probe = new FeedProbe(response.status, response.headers.get("content-type"), controller);
    if (response.status === 200 && response.body !== null) {
      void probe.consume(response.body);
    }
    return probe;
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const parser = createParser({
      onComment: () => {
        this.comments += 1;
      },
      onEvent: (message) => {
        this.messages.push({
          event: message.event,
          envelope: JSON.parse(message.data) as FeedEnvelope,
        });
      },
    });
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch {
      this.ended = true;
      return;
    }
    this.ended = true;
  }

  get types(): string[] {
    return this.messages.map((message) => message.envelope.type);
  }

  async waitUntil(condition: () => boolean, timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting; events so far: ${this.types.join(", ")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  waitForType(type: string, timeoutMs?: number): Promise<void> {
    return this.waitUntil(() => this.types.includes(type), timeoutMs);
  }

  close(): void {
    this.controller.abort();
  }
}

async function readJson<Body>(response: Response, expected: number): Promise<Body> {
  if (response.status !== expected) {
    throw new Error(`expected ${expected}, got ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Body;
}

export function createStage2Client(baseUrl: string): Stage2Client {
  const base = createStage1Client(baseUrl);
  const post = (path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const control: Stage2Control = {
    state: async () => readJson(await fetch(`${baseUrl}/__mock/stage2/state`), 200),
    seed: (seed) => post("/__mock/stage2/seed", { seed }),
    clock: (body) => post("/__mock/stage2/clock", body),
    advance: (body = {}) => post("/__mock/stage2/advance", body),
    settle: () => post("/__mock/stage2/advance", { until_idle: true }),
    hold: (phase, runId) => post("/__mock/stage2/hold", { phase, run_id: runId }),
    release: (body = {}) => post("/__mock/stage2/release", body),
    dropFeeds: () => post("/__mock/stage2/feeds/drop"),
    productionTarget: (allowProduction) =>
      post(
        "/__mock/stage2/production-target",
        allowProduction === undefined ? {} : { allow_production: allowProduction },
      ),
    faults: (patch) => post("/__mock/faults", patch),
  };

  const selection = (overrides: Partial<PlanSelection> = {}): PlanSelection => ({
    feature_ids: ["smart_log.read.open_maintenance"],
    area_ids: [],
    roles: ["guest"],
    interface_mode: "both",
    depth: "smoke",
    k: 1,
    ...overrides,
  });

  const planBody = (overrides: PlanBodyOverrides = {}): PlanCreate => ({
    target_id: GRACIE_ID,
    saved: false,
    ...overrides,
    selection: selection(overrides.selection),
  });

  const getRun = async (runId: string): Promise<Run> =>
    readJson(await base.get(`/api/v1/runs/${runId}`), 200);

  const client: Stage2Client = {
    ...base,
    control,
    selection,
    planBody,
    preview: async (body, role) =>
      readJson(await base.send("POST", "/api/v1/plans/preview", body, { role }), 200),
    createPlan: async (body, role) =>
      readJson(await base.send("POST", "/api/v1/plans", body, { role }), 201),
    startRun: (body, options = {}) =>
      base.send("POST", "/api/v1/runs", body, {
        role: options.role,
        headers:
          options.key === null ? {} : { "Idempotency-Key": options.key ?? crypto.randomUUID() },
      }),
    startInlineRun: async (overrides, targetId = GRACIE_ID) =>
      readJson(
        await client.startRun({
          plan: planBody({ target_id: targetId, selection: overrides }),
        }),
        202,
      ),
    getRun,
    runToEnd: async (runId) => {
      await control.settle();
      return getRun(runId);
    },
    waitForRun: async (runId, predicate, timeoutMs = DEFAULT_WAIT_MS) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const run = await getRun(runId);
        if (predicate(run)) {
          return run;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for run ${runId} in status ${run.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
    getEvents: async (runId) => {
      const events: Array<Record<string, unknown>> = [];
      let afterSeq = 0;
      for (;;) {
        const page = await readJson<{
          items: Array<Record<string, unknown>>;
          has_more: boolean;
        }>(await base.get(`/api/v1/runs/${runId}/events?limit=200&after_seq=${afterSeq}`), 200);
        events.push(...page.items);
        const last = page.items.at(-1);
        if (!page.has_more || typeof last?.seq !== "number") {
          return events;
        }
        afterSeq = last.seq;
      }
    },
    openRunSocket: async (runId, lastSeq) => {
      const token = await mintApiToken();
      const ticket = await requestWsTicket(baseUrl, token, runId);
      const suffix = lastSeq === undefined ? "" : `&last_seq=${lastSeq}`;
      return new SocketProbe(`${ticket.ws_url}${suffix}`);
    },
    feedUrl: (query = "") => `${baseUrl}/api/v1/feeds/runs${query === "" ? "" : `?${query}`}`,
    openFeed: async (query = "", options = {}) => {
      const token = options.token === undefined ? await mintApiToken() : options.token;
      return FeedProbe.open(client.feedUrl(query), token, options.signal);
    },
  };
  return client;
}

export function seqsOf(events: ReadonlyArray<{ seq?: unknown }>): number[] {
  return events.flatMap((event) => (typeof event.seq === "number" ? [event.seq] : []));
}

export function isGapFree(seqs: readonly number[]): boolean {
  return seqs.every((seq, index) => seq === index + 1);
}
