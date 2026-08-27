import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeAdvisory } from "../src/runtime";
import { IDS, TOKEN, agentSession, bundleSummary, environment, errorBody, target, user } from "./fixtures";
import { hello, json, startSse, startStub, until, type Stub } from "./sse-stub";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.PLUGIN_LIFECYCLE_SERVER ?? join(resolve(here, ".."), "dist", "server.cjs");
const EXIT_TRACER = join(here, "support", "exit-tracer.cjs");
const FEEDS = ["findings", "runs", "coverage"] as const;
const ROUNDS = 24;
const NATURAL_EXIT_BUDGET_MILLISECONDS = 5000;

type FeedMode = "stream" | "refuse";

type Outcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  exitMilliseconds: number;
  toolText: string;
  stderr: string;
};

function serveApi(stub: Stub, mode: FeedMode): void {
  stub.route("GET /api/v1/users/me", (_request, response) => json(response, 200, user));
  stub.route("POST /api/v1/agent-sessions", (_request, response) => json(response, 201, agentSession));
  stub.route(`PATCH /api/v1/agent-sessions/${IDS.agentSession}`, (_request, response) => json(response, 200, agentSession));
  stub.route(`GET /api/v1/targets/${IDS.target}`, (_request, response) => json(response, 200, target));
  stub.route(`GET /api/v1/targets/${IDS.target}/bundles`, (_request, response) =>
    json(response, 200, { items: [bundleSummary], next_cursor: null, total: null }),
  );
  stub.route(`GET /api/v1/targets/${IDS.target}/environment`, (_request, response) => json(response, 200, environment));
  stub.route(`GET /api/v1/targets/${IDS.target}/proposal`, (_request, response) => json(response, 404, errorBody("not_found", "No proposal")));
  stub.route("GET /api/v1/coverage", (_request, response) =>
    json(response, 200, { target_id: IDS.target, totals: { empty: 0, generated: 0, covered: 0, needs_author: 0, blocked: 0 }, cells: [] }),
  );
  for (const feed of FEEDS) {
    stub.route(`GET /api/v1/feeds/${feed}`, (_request, response) =>
      mode === "stream" ? startSse(response, hello(feed)) : json(response, 404, errorBody("not_found", "No feed")),
    );
  }
}

function feedRequests(stub: Stub): number {
  return FEEDS.reduce((total, feed) => total + stub.count(`/api/v1/feeds/${feed}`), 0);
}

function sessionEnds(stub: Stub): number {
  return stub.requests.filter(
    (request) => request.method === "PATCH" && request.path === `/api/v1/agent-sessions/${IDS.agentSession}` && request.body.includes('"ended_at"'),
  ).length;
}

function runServerOnce(stub: Stub): Promise<Outcome> {
  const feedsBefore = feedRequests(stub);
  return new Promise((resolveOutcome, reject) => {
    const child = spawn(process.execPath, ["--require", EXIT_TRACER, SERVER], {
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TESSA_URL: stub.url, TESSA_TOKEN: TOKEN },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let pending = "";
    let stderr = "";
    let toolText = "";
    let closedAt = 0;
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const closeWhenFeedsStarted = async () => {
      await until(() => feedRequests(stub) >= feedsBefore + FEEDS.length, 3000).catch(() => undefined);
      closedAt = Date.now();
      child.stdin.end();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line === "") {
          continue;
        }
        const message = JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> } };
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_target", arguments: { target_id: IDS.target } } });
        } else if (message.id === 2) {
          toolText = message.result?.content?.[0]?.text ?? line;
          void closeWhenFeedsStarted();
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      resolveOutcome({ code, signal, exitMilliseconds: closedAt === 0 ? -1 : Date.now() - closedAt, toolText, stderr }),
    );
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "lifecycle-test", version: "0.1.0" } },
    });
  });
}

const stubs: Partial<Record<FeedMode, Stub>> = {};

beforeAll(async () => {
  for (const mode of ["stream", "refuse"] as const) {
    const stub = await startStub();
    serveApi(stub, mode);
    stubs[mode] = stub;
  }
});

afterAll(async () => {
  for (const stub of Object.values(stubs)) {
    await stub?.close();
  }
});

describe("the built server as a child process", () => {
  it(
    `starts, runs get_target with the inbox feeds on and exits by itself with code 0, ${ROUNDS} times in a row`,
    async () => {
      const advisory = runtimeAdvisory(process.version, process.platform);
      for (let round = 1; round <= ROUNDS; round += 1) {
        const mode: FeedMode = round % 2 === 0 ? "refuse" : "stream";
        const stub = stubs[mode] as Stub;
        const endsBefore = sessionEnds(stub);
        const outcome = await runServerOnce(stub);
        const context = `round ${round} (${mode} feeds) on Node ${process.version}: exit ${outcome.code} ${outcome.signal ?? ""} after ${outcome.exitMilliseconds} ms${advisory === null ? "" : `; ${advisory}`}\n${outcome.stderr.slice(-1500)}`;
        expect(outcome.code, context).toBe(0);
        expect(outcome.signal, context).toBeNull();
        expect(outcome.stderr, context).not.toContain("Assertion failed");
        expect(outcome.stderr, context).not.toContain("exit-tracer: process.exit(");
        expect(JSON.parse(outcome.toolText).target.id, context).toBe(IDS.target);
        expect(outcome.exitMilliseconds, context).toBeGreaterThanOrEqual(0);
        expect(outcome.exitMilliseconds, context).toBeLessThan(NATURAL_EXIT_BUDGET_MILLISECONDS);
        expect(sessionEnds(stub), context).toBe(endsBefore + 1);
        expect(outcome.stderr.includes("node runtime has a known crash"), context).toBe(advisory !== null);
      }
    },
    60_000,
  );
});
