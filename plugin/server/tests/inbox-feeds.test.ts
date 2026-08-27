import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../src/client";
import { BACKOFF_MAX_MILLISECONDS, Inbox, backoffDelay } from "../src/inbox";
import { MemoryInboxStore } from "../src/inbox-store";
import { Redactor } from "../src/redact";
import { TOKEN } from "./fixtures";
import {
  FINDING,
  ITEM,
  PROPOSAL,
  RUN,
  TARGET,
  frame,
  hello,
  json,
  recordingClock,
  startSse,
  startStub,
  until,
  type Stub,
} from "./sse-stub";

const counters = (fail: number) => ({ scenarios_total: 4, scenarios_done: 4, pass: 4 - fail, fail, flaky: 0, uncertain: 0, skipped: 0, steps_recorded: 9 });

type Rig = { stub: Stub; inbox: Inbox; store: MemoryInboxStore; clock: ReturnType<typeof recordingClock>; logs: string[] };

let rig: Rig;
let stubs: Stub[] = [];

async function createRig(options: { idle?: number; random?: () => number } = {}): Promise<Rig> {
  const stub = await startStub();
  stubs.push(stub);
  const store = new MemoryInboxStore();
  const clock = recordingClock();
  const logs: string[] = [];
  const redactor = new Redactor();
  redactor.addLiteral(TOKEN);
  const inbox = new Inbox({
    baseUrl: stub.url,
    token: TOKEN,
    store,
    redactor,
    clock,
    random: options.random ?? (() => 0.5),
    idleTimeoutMilliseconds: options.idle,
    log: (message, fields) => logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
  });
  return { stub, inbox, store, clock, logs };
}

function serveCoverage(stub: Stub, value: () => number): void {
  stub.route("GET /api/v1/coverage", (_request, response) => {
    json(response, 200, { target_id: TARGET, totals: { empty: 0, generated: 0, covered: 1, needs_author: value(), blocked: 0 }, cells: [] });
  });
}

beforeEach(() => {
  stubs = [];
});

afterEach(async () => {
  if (rig !== undefined) {
    await rig.inbox.stop();
  }
  await Promise.all(stubs.map((stub) => stub.close()));
});

describe("inbox feeds", () => {
  it("reads the three feeds of a watched target with the bearer header and keeps only the planned events", async () => {
    rig = await createRig();
    const { stub, inbox, store } = rig;
    serveCoverage(stub, () => 1);
    stub.route("GET /api/v1/feeds/findings", (_request, response) => {
      startSse(
        response,
        hello("findings"),
        frame("finding.updated", { finding_id: FINDING, changes: {} }),
        frame("finding.created", { finding_id: FINDING, title: "Refund <img src=x onerror=1> total wrong", class: "bug", severity: "high", status: "open", fingerprint: "f", is_new: true, scenario_id: null }, { run_id: RUN, seq: 4 }),
      );
    });
    stub.route("GET /api/v1/feeds/runs", (_request, response) => {
      startSse(
        response,
        hello("runs"),
        frame("run.finished", { status: "completed", counters: counters(0), spent_usd: 0.1, duration_ms: 10 }, { run_id: "66666666-6666-4666-8666-666666666666", seq: 3 }),
        frame("run.finished", { status: "completed", counters: counters(2), spent_usd: 0.1, duration_ms: 10 }, { run_id: RUN, seq: 12 }),
      );
    });
    stub.route("GET /api/v1/feeds/coverage", (_request, response) => {
      startSse(
        response,
        hello("coverage"),
        frame("generation.progress", { cells_total: 5, cells_done: 2, scenarios_created: 1, scenarios_invalid: 0 }, { run_id: RUN, seq: 2 }),
        frame("generation.progress", { cells_total: 5, cells_done: 5, scenarios_created: 4, scenarios_invalid: 1 }, { run_id: RUN, seq: 6 }),
        frame("proposal.updated", { target_id: TARGET, proposal_id: PROPOSAL, item_id: ITEM, status: "proposed" }),
        frame("proposal.updated", { target_id: TARGET, proposal_id: PROPOSAL, item_id: ITEM, status: "selected" }),
      );
    });

    inbox.watch(TARGET);
    await until(async () => (await store.read()).length >= 4);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const lines = await store.read();
    expect(lines).toHaveLength(4);
    expect(lines.some((line) => line.startsWith(`kind=finding.created target=${TARGET} id=${FINDING} `))).toBe(true);
    expect(lines.some((line) => line.startsWith(`kind=run.finished target=${TARGET} id=${RUN} `) && line.includes("fail=2"))).toBe(true);
    expect(lines.some((line) => line.startsWith(`kind=generation.progress target=${TARGET} id=${RUN} `))).toBe(true);
    expect(lines.some((line) => line.startsWith(`kind=proposal.updated target=${TARGET} id=${ITEM} `))).toBe(true);
    for (const line of lines) {
      expect(line).not.toMatch(/[<>\n\r]/);
    }
    for (const feed of ["findings", "runs", "coverage"]) {
      const request = stub.requests.find((entry) => entry.path === `/api/v1/feeds/${feed}`);
      expect(request?.search).toBe(`?target_id=${TARGET}`);
      expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request?.headers.accept).toBe("text/event-stream");
    }
  });

  it("opens each feed once per target even when the target is watched twice", async () => {
    rig = await createRig();
    const { stub, inbox } = rig;
    for (const feed of ["findings", "runs", "coverage"]) {
      stub.route(`GET /api/v1/feeds/${feed}`, (_request, response) => startSse(response, hello(feed)));
    }
    serveCoverage(stub, () => 0);
    inbox.watch(TARGET);
    inbox.watch(TARGET);
    await until(() => stub.count("/api/v1/feeds/findings") >= 1 && stub.count("/api/v1/feeds/runs") >= 1 && stub.count("/api/v1/feeds/coverage") >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.count("/api/v1/feeds/findings")).toBe(1);
    expect(inbox.watchedTargets).toEqual([TARGET]);
  });

  it("deduplicates an event that arrives twice", async () => {
    rig = await createRig();
    const { stub, inbox, store } = rig;
    serveCoverage(stub, () => 0);
    const created = frame("finding.created", { finding_id: FINDING, title: "same", class: "bug", severity: "low", status: "open", fingerprint: "f", is_new: true, scenario_id: null }, { run_id: RUN, seq: 1 });
    stub.route("GET /api/v1/feeds/findings", (_request, response) => startSse(response, hello("findings"), created, created));
    stub.route("GET /api/v1/feeds/runs", (_request, response) => startSse(response, hello("runs")));
    stub.route("GET /api/v1/feeds/coverage", (_request, response) => startSse(response, hello("coverage")));
    inbox.watch(TARGET);
    await until(async () => (await store.read()).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await store.read()).toHaveLength(1);
  });

  it("reconnects after the stream is dropped, with a jittered pause, and resubscribes on the next hello", async () => {
    rig = await createRig();
    const { stub, inbox, store, clock } = rig;
    serveCoverage(stub, () => 0);
    stub.route("GET /api/v1/feeds/findings", (_request, response, count) => {
      if (count === 1) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(hello("findings"));
        setTimeout(() => response.destroy(), 30);
        return;
      }
      startSse(response, hello("findings"), frame("finding.created", { finding_id: FINDING, title: "after reconnect", class: "bug", severity: "low", status: "open", fingerprint: "f", is_new: true, scenario_id: null }, { run_id: RUN, seq: 2 }));
    });
    stub.route("GET /api/v1/feeds/runs", (_request, response) => startSse(response, hello("runs")));
    stub.route("GET /api/v1/feeds/coverage", (_request, response) => startSse(response, hello("coverage")));
    inbox.watch(TARGET);
    await until(async () => (await store.read()).length >= 1);
    expect(stub.count("/api/v1/feeds/findings")).toBe(2);
    expect(clock.sleeps).toContain(750);
    expect(inbox.isRevoked).toBe(false);
  });

  it("reconnects after a server closing event such as max_age", async () => {
    rig = await createRig();
    const { stub, inbox } = rig;
    serveCoverage(stub, () => 0);
    stub.route("GET /api/v1/feeds/findings", (_request, response, count) => {
      if (count === 1) {
        startSse(response, hello("findings"), frame("stream.closing", { reason: "max_age" }));
        response.end();
        return;
      }
      startSse(response, hello("findings"));
    });
    stub.route("GET /api/v1/feeds/runs", (_request, response) => startSse(response, hello("runs")));
    stub.route("GET /api/v1/feeds/coverage", (_request, response) => startSse(response, hello("coverage")));
    inbox.watch(TARGET);
    await until(() => stub.count("/api/v1/feeds/findings") >= 2);
  });

  it("does not reconnect after stream.closing with reason unauthorized and stops every feed", async () => {
    rig = await createRig();
    const { stub, inbox, logs } = rig;
    serveCoverage(stub, () => 0);
    stub.route("GET /api/v1/feeds/findings", (_request, response) => {
      startSse(response, hello("findings"), frame("stream.closing", { reason: "unauthorized" }));
      response.end();
    });
    stub.route("GET /api/v1/feeds/runs", (_request, response) => startSse(response, hello("runs")));
    stub.route("GET /api/v1/feeds/coverage", (_request, response) => startSse(response, hello("coverage")));
    inbox.watch(TARGET);
    await until(() => inbox.isRevoked);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = stub.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stub.requests.length).toBe(before);
    expect(stub.count("/api/v1/feeds/findings")).toBe(1);
    expect(logs.some((entry) => entry.startsWith("inbox stopped"))).toBe(true);
    inbox.watch("77777777-7777-4777-8777-777777777777");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stub.requests.length).toBe(before);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("does not reconnect after a 401", async () => {
    rig = await createRig();
    const { stub, inbox } = rig;
    for (const feed of ["findings", "runs", "coverage"]) {
      stub.route(`GET /api/v1/feeds/${feed}`, (_request, response) => json(response, 401, { error: { code: "token_revoked", message: "revoked", request_id: "r" } }));
    }
    inbox.watch(TARGET);
    await until(() => inbox.isRevoked);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stub.count("/api/v1/feeds/findings")).toBeLessThanOrEqual(1);
    expect(stub.requests.length).toBeLessThanOrEqual(3);
  });

  it("backs off with growing jittered pauses while the server answers 503", async () => {
    rig = await createRig();
    const { stub, inbox, clock } = rig;
    serveCoverage(stub, () => 0);
    stub.route("GET /api/v1/feeds/findings", (_request, response, count) => {
      if (count <= 3) {
        json(response, 503, { error: { code: "dependency_unavailable", message: "down", request_id: "r" } });
        return;
      }
      startSse(response, hello("findings"));
    });
    stub.route("GET /api/v1/feeds/runs", (_request, response) => startSse(response, hello("runs")));
    stub.route("GET /api/v1/feeds/coverage", (_request, response) => startSse(response, hello("coverage")));
    inbox.watch(TARGET);
    await until(() => stub.count("/api/v1/feeds/findings") >= 4);
    expect(clock.sleeps).toEqual(expect.arrayContaining([750, 1500, 3000]));
  });

  it("reconnects when the stream goes silent for longer than the idle limit", async () => {
    rig = await createRig({ idle: 150 });
    const { stub, inbox } = rig;
    serveCoverage(stub, () => 0);
    stub.route("GET /api/v1/feeds/findings", (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(hello("findings"));
    });
    stub.route("GET /api/v1/feeds/runs", (_request, response) => startSse(response, hello("runs"), ": ping\n\n"));
    stub.route("GET /api/v1/feeds/coverage", (_request, response) => startSse(response, hello("coverage")));
    inbox.watch(TARGET);
    await until(() => stub.count("/api/v1/feeds/findings") >= 2);
  });

  it("follows needs_author on the coverage feed and reports growth only", async () => {
    rig = await createRig();
    const { stub, inbox, store } = rig;
    let needsAuthor = 2;
    serveCoverage(stub, () => needsAuthor);
    stub.route("GET /api/v1/feeds/findings", (_request, response) => startSse(response, hello("findings")));
    stub.route("GET /api/v1/feeds/runs", (_request, response) => startSse(response, hello("runs")));
    stub.route("GET /api/v1/feeds/coverage", (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(hello("coverage"));
      setTimeout(() => {
        needsAuthor = 5;
        response.write(frame("coverage.updated", { target_id: TARGET, plan_id: PROPOSAL, cell_ids: [], reason: "generated" }, { ts: "2026-10-09T10:01:00Z" }));
      }, 100);
      setTimeout(() => {
        needsAuthor = 5;
        response.write(frame("coverage.updated", { target_id: TARGET, plan_id: PROPOSAL, cell_ids: [], reason: "run" }, { ts: "2026-10-09T10:02:00Z" }));
      }, 200);
      setTimeout(() => {
        needsAuthor = 3;
        response.write(frame("coverage.updated", { target_id: TARGET, plan_id: PROPOSAL, cell_ids: [], reason: "review" }, { ts: "2026-10-09T10:03:00Z" }));
      }, 300);
    });
    inbox.watch(TARGET);
    await until(async () => (await store.read()).length >= 1);
    await until(() => stub.count("/api/v1/coverage") >= 4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lines = await store.read();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`kind=coverage.updated target=${TARGET} id=${PROPOSAL} needs_author grew from 2 to 5 reason=generated`);
  });

  it("never echoes the token into a line", async () => {
    rig = await createRig();
    const { stub, inbox, store } = rig;
    serveCoverage(stub, () => 0);
    stub.route("GET /api/v1/feeds/findings", (_request, response) => {
      startSse(response, hello("findings"), frame("finding.created", { finding_id: FINDING, title: `leaked ${TOKEN} here`, class: "bug", severity: "low", status: "open", fingerprint: "f", is_new: true, scenario_id: null }, { run_id: RUN, seq: 1 }));
    });
    stub.route("GET /api/v1/feeds/runs", (_request, response) => startSse(response, hello("runs")));
    stub.route("GET /api/v1/feeds/coverage", (_request, response) => startSse(response, hello("coverage")));
    inbox.watch(TARGET);
    await until(async () => (await store.read()).length >= 1);
    const [line] = await store.read();
    expect(line).not.toContain(TOKEN);
    expect(line).toContain("[redacted]");
  });
});

describe("finishing feed requests", () => {
  function inboxWith(fetchImpl: typeof fetch, clock = recordingClock()) {
    return new Inbox({
      baseUrl: "http://tessa.test",
      token: TOKEN,
      store: new MemoryInboxStore(),
      redactor: new Redactor(),
      clock,
      random: () => 0.5,
      log: () => undefined,
      fetchImpl,
    });
  }

  it("reads a refused feed's body to the end and never aborts a request whose body has finished", async () => {
    const seen: Array<{ signal: AbortSignal; pulls: number; cancelled: boolean }> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const record = { signal: init?.signal as AbortSignal, pulls: 0, cancelled: false };
      seen.push(record);
      const chunks = [new TextEncoder().encode('{"error":'), new TextEncoder().encode('{"code":"not_found"}}')];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          record.pulls += 1;
          const next = chunks.shift();
          if (next === undefined) {
            controller.close();
          } else {
            controller.enqueue(next);
          }
        },
        cancel() {
          record.cancelled = true;
        },
      });
      return new Response(body, { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const inbox = inboxWith(fetchImpl);
    inbox.watch(TARGET);
    await until(() => seen.length === 3 && seen.every((record) => record.pulls >= 3));
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    for (const record of seen) {
      expect(record.cancelled).toBe(false);
      expect(record.signal.aborted).toBe(false);
    }
    await inbox.stop();
    expect(seen.every((record) => !record.signal.aborted)).toBe(true);
  });

  it("aborts the request of a feed that is still streaming when the inbox stops", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(hello("findings")));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const inbox = inboxWith(fetchImpl);
    inbox.watch(TARGET);
    await until(() => signals.length === 3);
    await inbox.stop();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("hands its stop signal to the backoff pause, so stopping ends the wait", async () => {
    const pauses: Array<AbortSignal | undefined> = [];
    const clock = {
      now: () => Date.now(),
      sleep: (_milliseconds: number, signal?: AbortSignal) => {
        pauses.push(signal);
        return new Promise<void>((resolveSleep) => signal?.addEventListener("abort", () => resolveSleep(), { once: true }));
      },
    };
    const fetchImpl = (async () => new Response("busy", { status: 503 })) as typeof fetch;
    const inbox = inboxWith(fetchImpl, clock as unknown as ReturnType<typeof recordingClock>);
    inbox.watch(TARGET);
    await until(() => pauses.length === 3);
    expect(pauses.every((signal) => signal !== undefined && !signal.aborted)).toBe(true);
    await inbox.stop();
    expect(pauses.every((signal) => signal?.aborted === true)).toBe(true);
  });
});

describe("systemClock.sleep", () => {
  it("ends at once and leaves no timer behind when its signal aborts", async () => {
    const timersBefore = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = systemClock.sleep(60_000, controller.signal);
    expect(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length).toBe(timersBefore + 1);
    controller.abort();
    await pending;
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length).toBe(timersBefore);
    const alreadyAborted = AbortSignal.abort();
    await systemClock.sleep(60_000, alreadyAborted);
    expect(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length).toBe(timersBefore);
  });

  it("still waits without a signal", async () => {
    const startedAt = Date.now();
    await systemClock.sleep(30);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });
});

describe("backoffDelay", () => {
  it("grows from one second to the sixty second ceiling with jitter between half and full", () => {
    expect(backoffDelay(1, () => 0)).toBe(500);
    expect(backoffDelay(1, () => 1)).toBe(1000);
    expect(backoffDelay(2, () => 1)).toBe(2000);
    expect(backoffDelay(6, () => 1)).toBe(32_000);
    expect(backoffDelay(7, () => 1)).toBe(BACKOFF_MAX_MILLISECONDS);
    expect(backoffDelay(50, () => 1)).toBe(BACKOFF_MAX_MILLISECONDS);
    expect(backoffDelay(50, () => 0)).toBe(BACKOFF_MAX_MILLISECONDS / 2);
  });
});
