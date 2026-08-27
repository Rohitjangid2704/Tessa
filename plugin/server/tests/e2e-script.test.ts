import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IDS,
  TOKEN,
  agentSession,
  bundle,
  bundleSummary,
  environment,
  errorBody,
  findingSummary,
  run,
  scenarioSummary,
  target,
  user,
  validationReport,
} from "./fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(here, "..");
const SCRIPT = join(SERVER_ROOT, "e2e", "real.mjs");
const DIST = join(SERVER_ROOT, "dist", "server.cjs");

type Helpers = {
  readSettings: (env: Record<string, string | undefined>) => Record<string, unknown>;
  renderTable: (rows: { name: string; status: string; detail: string }[]) => string;
  findLeak: (token: string, texts: string[]) => boolean;
  serverLogSection: (stderrText: string, token: string, serverState: string) => string;
};

let helpers: Helpers;

beforeAll(async () => {
  helpers = (await import(pathToFileURL(SCRIPT).href)) as Helpers;
});

function runScript(env: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

const validEnv = {
  TESSA_URL: "http://127.0.0.1:1",
  TESSA_TEST_TOKEN: TOKEN,
  TESSA_TEST_TARGET_ID: IDS.target,
};

describe("e2e/real.mjs settings", () => {
  it("skips when the url or the token is missing", () => {
    expect(helpers.readSettings({})).toHaveProperty("skip");
    expect(helpers.readSettings({ TESSA_URL: "http://x" })).toHaveProperty("skip");
    expect(helpers.readSettings({ TESSA_TEST_TOKEN: TOKEN })).toHaveProperty("skip");
  });

  it("reports every problem in the environment", () => {
    const result = helpers.readSettings({
      TESSA_URL: "http://x",
      TESSA_TEST_TOKEN: "abc",
      TESSA_TEST_TARGET_ID: "nope",
      TESSA_TEST_PLAN_ID: "nope",
      TESSA_E2E_WAIT_SECONDS: "99999",
    });
    expect((result.problems as string[]).length).toBe(4);
  });

  it("accepts a complete environment and defaults the wait", () => {
    expect(helpers.readSettings(validEnv)).toMatchObject({
      url: "http://127.0.0.1:1",
      token: TOKEN,
      targetId: IDS.target,
      planId: null,
      waitSeconds: 600,
    });
  });

  it("renders a table and detects a leaked token", () => {
    const table = helpers.renderTable([
      { name: "whoami", status: "ok", detail: "member" },
      { name: "start_run", status: "FAIL", detail: "boom" },
    ]);
    expect(table.split("\n")).toHaveLength(3);
    expect(helpers.findLeak(TOKEN, ["fine", `has ${TOKEN}`])).toBe(true);
    expect(helpers.findLeak(TOKEN, ["fine", "ipt_other"])).toBe(false);
  });

  it("shows the server log redacted, with how the server process ended", () => {
    const log = `{"message":"agent session was not created","error":"401 ${TOKEN}"}\nAuthorization: Bearer abcdefghijkl\nother ipt_OtherToken12345\n`;
    const section = helpers.serverLogSection(log, TOKEN, "exited on its own with code 3221226505");
    expect(section.split("\n")[0]).toBe("server process: exited on its own with code 3221226505");
    expect(section).toContain("agent session was not created");
    expect(section).not.toContain(TOKEN);
    expect(section).not.toContain("abcdefghijkl");
    expect(section).not.toContain("ipt_OtherToken12345");
    expect(section).toContain("[redacted]");
  });

  it("keeps the end of a long server log and says when the log is empty", () => {
    const section = helpers.serverLogSection(`${"x".repeat(10_000)}LAST LINE`, TOKEN, "still running");
    expect(section).toContain("(last 4000 characters)");
    expect(section.endsWith("LAST LINE")).toBe(true);
    expect(section.length).toBeLessThan(4200);
    expect(helpers.serverLogSection(" \n", TOKEN, "still running")).toContain("(empty)");
  });
});

describe("e2e/real.mjs as a script", () => {
  it("exits 0 with a clear message and calls nothing when the environment is not set", async () => {
    const result = await runScript({});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("skipping the real-API e2e");
  });

  it("exits 1 on a bad environment without starting the server", async () => {
    const result = await runScript({ ...validEnv, TESSA_TEST_TARGET_ID: "nope" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("TESSA_TEST_TARGET_ID");
    expect(result.stdout).toBe("");
  });
});

type FakeApi = { server: Server; url: string; hits: string[] };

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function startFakeApi(mode: "healthy" | "echo-token"): Promise<FakeApi> {
  const hits: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = `${request.method} ${url.pathname}`;
    hits.push(route);
    request.resume();
    request.on("end", () => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        json(response, 401, errorBody("unauthorized", "bad token"));
        return;
      }
      const path = url.pathname.replace("/api/v1", "");
      if (mode === "echo-token" && path === "/users/me") {
        json(response, 401, errorBody("token_revoked", `rejected Bearer ${TOKEN}`));
        return;
      }
      if (request.method === "GET" && path === "/users/me") return json(response, 200, user);
      if (request.method === "POST" && path === "/agent-sessions") return json(response, 201, agentSession);
      if (request.method === "PATCH" && path.startsWith("/agent-sessions/")) return json(response, 200, agentSession);
      if (request.method === "GET" && path === `/targets/${IDS.target}`) return json(response, 200, target);
      if (request.method === "GET" && path === `/targets/${IDS.target}/bundles`) {
        return json(response, 200, { items: [bundleSummary], next_cursor: null, total: null });
      }
      if (request.method === "GET" && path === `/targets/${IDS.target}/environment`) return json(response, 200, environment);
      if (request.method === "GET" && path === `/targets/${IDS.target}/proposal`) {
        return json(response, 404, errorBody("not_found", "No proposal"));
      }
      if (request.method === "POST" && path === "/bundles/validate") {
        return json(response, 200, { ...validationReport, validation_status: "valid", errors: [], fixup_items: [] });
      }
      if (request.method === "POST" && path === "/bundles") {
        return json(response, 201, { bundle, created: true, dry_run_run_id: IDS.run });
      }
      if (request.method === "GET" && path === "/scenarios") {
        return json(response, 200, { items: [scenarioSummary(0), scenarioSummary(1)], next_cursor: null, total: null });
      }
      if (request.method === "POST" && path === "/runs") {
        return json(response, 202, {
          run_id: IDS.run,
          status: "queued",
          kind: "suite",
          workflow_id: "wf-1",
          created_at: "2026-10-08T10:00:00Z",
        });
      }
      if (request.method === "GET" && path === `/runs/${IDS.run}`) return json(response, 200, run("completed"));
      if (request.method === "GET" && path === "/findings") {
        return json(response, 200, { items: [findingSummary], next_cursor: null, total: null });
      }
      return json(response, 404, errorBody("not_found", route));
    });
  });
  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveStart({ server, url: `http://127.0.0.1:${port}`, hits });
    });
  });
}

describe("e2e/real.mjs against the built server and a local stub API", () => {
  const apis: FakeApi[] = [];

  afterAll(() => {
    for (const api of apis) {
      api.server.close();
    }
  });

  it("has the committed server bundle to start", () => {
    expect(existsSync(DIST), `${DIST} is missing; run npm run build`).toBe(true);
  });

  it("walks the whole tool chain and prints an all-ok table", async () => {
    const api = await startFakeApi("healthy");
    apis.push(api);
    const result = await runScript({ ...validEnv, TESSA_URL: api.url, TESSA_E2E_WAIT_SECONDS: "20" });
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("FAIL");
    expect(result.stdout).not.toContain("server stderr");
    for (const name of [
      "whoami",
      "get_target",
      "validate_bundle",
      "upload_bundle",
      "get_environment",
      "list_scenarios",
      "start_run",
      "wait_run",
      "list_findings",
      "token_not_leaked",
    ]) {
      expect(result.stdout, name).toMatch(new RegExp(`${name}\\s+ok`));
    }
    expect(result.code).toBe(0);
    expect(api.hits).toContain("POST /api/v1/bundles");
    expect(api.hits).toContain("POST /api/v1/runs");
    expect(result.stdout).not.toContain(TOKEN);
  });

  it("fails with a table, skips the dependent steps and never prints the token that the API echoed back", async () => {
    const api = await startFakeApi("echo-token");
    apis.push(api);
    const result = await runScript({ ...validEnv, TESSA_URL: api.url });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/whoami\s+FAIL/);
    expect(result.stdout).toMatch(/upload_bundle\s+SKIP/);
    expect(result.stdout).toMatch(/token_not_leaked\s+ok/);
    expect(result.stdout).toMatch(/\nserver process: still running when the client closed it\nserver stderr, redacted:\n/);
    expect(result.stdout.indexOf("server stderr")).toBeGreaterThan(result.stdout.indexOf("token_not_leaked"));
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stderr).not.toContain(TOKEN);
  });
});
