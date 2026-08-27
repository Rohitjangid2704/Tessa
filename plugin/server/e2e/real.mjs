import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { redactSecrets } from "../../scripts/hook-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MAX_SERVER_LOG_CHARACTERS = 4000;
const SERVER_PATH = resolve(here, "..", "dist", "server.cjs");
const FIXTURE_FOLDER = resolve(here, "..", "..", "..", "deploy", "fixtures", "adapters", "graphql_app", "tessa");
const MAX_WAIT_SECONDS = 1800;
const DEFAULT_WAIT_SECONDS = 600;
const SUBSET_SIZE = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readSettings(env) {
  const url = (env.TESSA_URL ?? "").trim();
  const token = (env.TESSA_TEST_TOKEN ?? "").trim();
  if (url === "" || token === "") {
    return {
      skip: "TESSA_URL and TESSA_TEST_TOKEN are not both set; skipping the real-API e2e (nothing was called).",
    };
  }
  const problems = [];
  if (!token.startsWith("ipt_")) {
    problems.push("TESSA_TEST_TOKEN must be a personal token that starts with ipt_");
  }
  const targetId = (env.TESSA_TEST_TARGET_ID ?? "").trim();
  if (!UUID.test(targetId)) {
    problems.push("TESSA_TEST_TARGET_ID must be the uuid of the graphql_app fixture target");
  }
  const planId = (env.TESSA_TEST_PLAN_ID ?? "").trim();
  if (planId !== "" && !UUID.test(planId)) {
    problems.push("TESSA_TEST_PLAN_ID must be a uuid");
  }
  const rawWait = (env.TESSA_E2E_WAIT_SECONDS ?? "").trim();
  let waitSeconds = DEFAULT_WAIT_SECONDS;
  if (rawWait !== "") {
    waitSeconds = Number(rawWait);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > MAX_WAIT_SECONDS) {
      problems.push(`TESSA_E2E_WAIT_SECONDS must be an integer from 1 to ${MAX_WAIT_SECONDS}`);
    }
  }
  if (problems.length > 0) {
    return { problems };
  }
  return { url, token, targetId, planId: planId === "" ? null : planId, waitSeconds };
}

export function renderTable(rows) {
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const lines = [`${"step".padEnd(nameWidth)}  result  detail`];
  for (const row of rows) {
    lines.push(`${row.name.padEnd(nameWidth)}  ${row.status.padEnd(6)}  ${row.detail}`);
  }
  return lines.join("\n");
}

export function findLeak(token, texts) {
  return texts.some((text) => text.includes(token) || text.includes(token.slice(0, 24)));
}

export function serverLogSection(stderrText, token, serverState) {
  const characters = Array.from(redactSecrets(stderrText, { CLAUDE_PLUGIN_OPTION_API_TOKEN: token }).trimEnd());
  const cut = characters.length > MAX_SERVER_LOG_CHARACTERS;
  const body = characters.slice(-MAX_SERVER_LOG_CHARACTERS).join("");
  return [
    `server process: ${serverState}`,
    `server stderr${cut ? ` (last ${MAX_SERVER_LOG_CHARACTERS} characters)` : ""}, redacted:`,
    body.trim() === "" ? "(empty)" : body,
  ].join("\n");
}

function parseResult(result) {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = first && first.type === "text" ? first.text : "";
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { text, body, isError: result.isError === true };
}

async function main(env) {
  const settings = readSettings(env);
  if (settings.skip) {
    process.stdout.write(`${settings.skip}\n`);
    return 0;
  }
  if (settings.problems) {
    process.stderr.write(`${settings.problems.join("\n")}\n`);
    return 1;
  }
  if (!existsSync(SERVER_PATH)) {
    process.stderr.write(`built server not found at ${SERVER_PATH}; run npm run build first\n`);
    return 1;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: { TESSA_URL: settings.url, TESSA_TOKEN: settings.token },
    stderr: "pipe",
  });
  let stderrText = "";
  transport.stderr?.on("data", (chunk) => {
    stderrText += chunk.toString("utf8");
  });
  const client = new Client({ name: "tessa-e2e", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  let serverState = "still running when the client closed it";
  transport._process?.on("exit", (code, signal) => {
    serverState = `exited on its own with code ${code}${signal ? ` and signal ${signal}` : ""}`;
  });

  const rows = [];
  const texts = [];
  const state = {};

  async function step(name, tool, args, verify, timeoutMs = 60000) {
    try {
      const raw = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
      const parsed = parseResult(raw);
      texts.push(parsed.text);
      if (parsed.isError || parsed.body === null) {
        rows.push({ name, status: "FAIL", detail: parsed.text.slice(0, 200) });
        return null;
      }
      const verdict = verify(parsed.body);
      rows.push({ name, status: verdict.ok ? "ok" : "FAIL", detail: verdict.detail });
      return verdict.ok ? parsed.body : null;
    } catch (error) {
      rows.push({ name, status: "FAIL", detail: String(error?.message ?? error).slice(0, 200) });
      return null;
    }
  }

  const who = await step("whoami", "whoami", {}, (body) => ({
    ok: typeof body.user?.id === "string" && String(body.token_prefix ?? "").startsWith("ipt_"),
    detail: `${body.user?.role ?? "?"} ${body.token_prefix ?? ""}`,
  }));

  const target = who
    ? await step("get_target", "get_target", { target_id: settings.targetId }, (body) => ({
        ok: body.production !== true,
        detail: body.production === true ? "refusing to run on a production target" : `${body.target?.name} (${body.target?.tier})`,
      }))
    : null;
  state.target = target;

  const validated = target
    ? await step("validate_bundle", "validate_bundle", { path: FIXTURE_FOLDER, target_id: settings.targetId }, (body) => ({
        ok: body.errors?.total === 0,
        detail: `${body.validation_status}, ${body.errors?.total ?? "?"} errors, ${body.warnings?.total ?? "?"} warnings, ${body.zip?.file_count ?? "?"} files`,
      }))
    : null;

  const uploaded = validated
    ? await step(
        "upload_bundle",
        "upload_bundle",
        { path: FIXTURE_FOLDER, target_id: settings.targetId, note: "plugin e2e" },
        (body) => ({
          ok: typeof body.bundle?.id === "string" && body.bundle?.errors?.total === 0,
          detail: `version ${body.bundle?.version}, created ${body.created}, dry run ${body.dry_run_run_id ?? "none"}`,
        }),
        120000,
      )
    : null;

  const environment = uploaded
    ? await step("get_environment", "get_environment", { target_id: settings.targetId }, (body) => ({
        ok: Array.isArray(body.variables) && body.variables.every((variable) => !("value" in variable)),
        detail: `${body.variables?.length ?? 0} variables, ${body.missing_required ?? "?"} required without a value`,
      }))
    : null;

  let runArgs = null;
  if (environment) {
    if (settings.planId !== null) {
      runArgs = { plan_id: settings.planId };
    } else {
      const scenarios = await step(
        "list_scenarios",
        "list_scenarios",
        { target_id: settings.targetId, status: "accepted", limit: SUBSET_SIZE },
        (body) => ({
          ok: Array.isArray(body.scenarios) && body.scenarios.length > 0,
          detail: `${body.scenarios?.length ?? 0} accepted scenarios (set TESSA_TEST_PLAN_ID to use a saved plan)`,
        }),
      );
      if (scenarios) {
        runArgs = { target_id: settings.targetId, scenario_ids: scenarios.scenarios.map((scenario) => scenario.id) };
      }
    }
  }

  const started = runArgs
    ? await step("start_run", "start_run", runArgs, (body) => ({
        ok: typeof body.run_id === "string",
        detail: `${body.kind} ${body.status} ${body.run_id}`,
      }))
    : null;

  const waited = started
    ? await step(
        "wait_run",
        "wait_run",
        { run_id: started.run_id, timeout_s: settings.waitSeconds },
        (body) => ({
          ok: body.timed_out === false && body.run?.status === "completed",
          detail: body.timed_out
            ? `still ${body.run?.status} after ${settings.waitSeconds}s`
            : `${body.run?.status}, counters ${JSON.stringify(body.run?.counters ?? {})}`,
        }),
        (settings.waitSeconds + 60) * 1000,
      )
    : null;

  if (waited) {
    await step("list_findings", "list_findings", { target_id: settings.targetId }, (body) => ({
      ok: Array.isArray(body.findings),
      detail: `${body.findings?.length ?? 0} findings`,
    }));
  }

  const skipped = ["get_target", "validate_bundle", "upload_bundle", "get_environment", "start_run", "wait_run", "list_findings"].filter(
    (name) => !rows.some((row) => row.name === name),
  );
  for (const name of skipped) {
    rows.push({ name, status: "SKIP", detail: "an earlier step failed" });
  }

  const serverStateBeforeClose = serverState;
  await client.close().catch(() => undefined);

  const leaked = findLeak(settings.token, [...texts, stderrText]);
  rows.push({ name: "token_not_leaked", status: leaked ? "FAIL" : "ok", detail: "results and server log" });

  process.stdout.write(`${renderTable(rows)}\n`);
  if (rows.some((row) => row.status === "FAIL")) {
    process.stdout.write(`\n${serverLogSection(stderrText, settings.token, serverStateBeforeClose)}\n`);
  }
  return rows.some((row) => row.status === "FAIL" || row.status === "SKIP") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`e2e failed: ${String(error?.message ?? error).replaceAll(process.env.TESSA_TEST_TOKEN ?? "\u0000", "[redacted]")}\n`);
      process.exitCode = 1;
    },
  );
}
