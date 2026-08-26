import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);

const mode = options.mode ?? "resume";
const baseUrl = options.url ?? "http://localhost:3000";
const apiUrl = options.api ?? "http://localhost:8000";
const email = options.email ?? process.env.E2E_USER_EMAIL ?? "admin@tessa.local";
const password = options.password ?? process.env.E2E_USER_PASSWORD ?? "dev-only-admin-password-1";
const ticks = Number(options.ticks ?? 20);
const intervalMs = Number(options.interval ?? 1000);
const killAfterTicks = Number(options.killAfterTicks ?? 4);
const downMs = Number(options.downMs ?? 4000);
const apiPid = options.apiPid === undefined ? null : Number(options.apiPid);
const apiDirectory = options.apiDir ?? null;
const apiLogPrefix = options.apiLog ?? null;
const pidOut = options.pidOut ?? null;
const reportPath = options.out ?? null;
const POLL_MS = 150;
const FINISH_TIMEOUT_MS = 120_000;
const API_START_TIMEOUT_MS = 90_000;

const startedAt = Date.now();
const timeline = [];
const checks = [];

function elapsed() {
  return Date.now() - startedAt;
}

function note(message, detail) {
  timeline.push({ atMs: elapsed(), message, detail });
  console.log(
    `[${String(elapsed()).padStart(6)} ms] ${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
}

function record(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
}

function killProcessTree(pid) {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

async function apiIsDown() {
  try {
    await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return false;
  } catch {
    return true;
  }
}

function startApi() {
  if (apiDirectory === null || apiLogPrefix === null) {
    throw new Error("--apiDir and --apiLog are needed to restart the API");
  }
  const out = openSync(`${apiLogPrefix}.restart.out.log`, "a");
  const err = openSync(`${apiLogPrefix}.restart.err.log`, "a");
  const uv = execFileSync("where.exe", ["uv"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
  const child = spawn(uv, ["run", "uvicorn", "tessa_api.main:app", "--port", "8000"], {
    cwd: apiDirectory,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  child.unref();
  closeSync(out);
  closeSync(err);
  if (pidOut !== null) {
    writeFileSync(pidOut, String(child.pid));
  }
  return child.pid;
}

async function waitForApiHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        return true;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const status = document.querySelector('[data-testid="hello-status"]');
    const lastSeq = document.querySelector('[data-testid="hello-last-seq"]');
    const indicator = status?.querySelector("[data-state]");
    const items = Array.from(document.querySelectorAll('[data-testid="hello-events"] li'));
    return {
      phase: status?.getAttribute("data-phase") ?? null,
      title: document.querySelector('[data-testid="hello-phase"]')?.textContent ?? null,
      detail: status?.querySelector("p.text-sm.text-muted-foreground")?.textContent ?? null,
      liveState: indicator?.getAttribute("data-state") ?? null,
      lastSeq: lastSeq?.textContent ?? null,
      events: items.map((item) => ({
        type: item.getAttribute("data-event-type"),
        seq: item.getAttribute("data-seq") === null ? null : Number(item.getAttribute("data-seq")),
      })),
      toasts: document.querySelectorAll("[data-sonner-toast]").length,
    };
  });
}

function persistedSeqs(events) {
  return events.flatMap((event) => (event.seq === null ? [] : [event.seq]));
}

function isStrictlyConsecutiveFromOne(seqs) {
  return seqs.every((seq, index) => seq === index + 1);
}

async function pollUntil(page, predicate, timeoutMs, onChange) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  while (Date.now() < deadline) {
    const current = await snapshot(page);
    const signature = `${current.phase}|${current.liveState}|${current.lastSeq}`;
    if (signature !== previous) {
      previous = signature;
      onChange?.(current);
    }
    if (predicate(current)) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

function describeSnapshot(current) {
  return {
    phase: current.phase,
    liveState: current.liveState,
    lastSeq: current.lastSeq,
    listed: persistedSeqs(current.events).length,
    detail: current.detail,
  };
}

async function readRunLog(context, runId) {
  const mint = await context.request.get(`${baseUrl}/api/session/api-token`);
  const { token } = await mint.json();
  const response = await context.request.get(`${apiUrl}/api/v1/runs/${runId}/events?limit=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await response.json()).items;
}

const browser = await chromium.launch({ headless: options.headed !== "true" });
const signInContext = await browser.newContext({ baseURL: baseUrl });
const signInPage = await signInContext.newPage();
await signInPage.goto("/login");
await signInPage.getByLabel(/email/i).fill(email);
await signInPage.getByLabel(/password/i).fill(password);
await signInPage.getByRole("button", { name: /sign in|log in/i }).click();
await signInPage.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
const storageState = await signInContext.storageState();
await signInContext.close();

const context = await browser.newContext({ baseURL: baseUrl, storageState });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text().slice(0, 200));
  }
});
await page.goto("/dev/hello");
await page.getByTestId("hello-status").waitFor();

async function configureAndStart(tickCount, interval, includeLaya = true) {
  await page.getByLabel("Ticks").fill(String(tickCount));
  await page.getByLabel("Interval (ms)").fill(String(interval));
  const layaSwitch = page.getByRole("switch", { name: "Include Laya" });
  if ((await layaSwitch.isChecked()) !== includeLaya) {
    await layaSwitch.click();
  }
  await page.getByRole("button", { name: "Start hello run" }).click();
}

async function runIdFromPage() {
  await page.waitForURL(/run_id=/, { timeout: 30_000 });
  return new URL(page.url()).searchParams.get("run_id");
}

if (mode === "resume") {
  if (apiPid === null) {
    throw new Error("--apiPid is required for the resume scenario");
  }
  const expectedEvents = 2 + ticks + 1 + 1;
  await configureAndStart(ticks, intervalMs);
  note("started hello run", { ticks, intervalMs, expectedEvents });
  const runId = await runIdFromPage();
  note("run id in the URL", { runId });

  const beforeKill = await pollUntil(
    page,
    (current) =>
      current.events.filter((event) => event.type === "hello.tick").length >= killAfterTicks,
    60_000,
    (current) => note("page", describeSnapshot(current)),
  );
  record(
    "streaming before the kill",
    beforeKill?.phase === "streaming",
    beforeKill && describeSnapshot(beforeKill),
  );
  const seqAtKill = persistedSeqs(beforeKill?.events ?? []).at(-1) ?? 0;

  killProcessTree(apiPid);
  note("killed the API process tree", { pid: apiPid, lastSeqSeenByThePage: seqAtKill });
  record("the API is down after the kill", await apiIsDown(), { url: `${apiUrl}/health` });

  const reconnecting = await pollUntil(
    page,
    (current) => current.phase === "reconnecting",
    30_000,
    (current) => note("page", describeSnapshot(current)),
  );
  record(
    "page reaches reconnecting while the API is down",
    reconnecting !== null,
    reconnecting && describeSnapshot(reconnecting),
  );
  if (reconnecting !== null) {
    record("live indicator says reconnecting", reconnecting.liveState === "reconnecting", {
      liveState: reconnecting.liveState,
    });
  }

  const stillDown = await pollUntil(
    page,
    () => false,
    downMs,
    (current) => note("page (API still down)", describeSnapshot(current)),
  );
  void stillDown;
  const duringOutage = await snapshot(page);
  record(
    "page stays reconnecting for the whole outage",
    duringOutage.phase === "reconnecting",
    describeSnapshot(duringOutage),
  );

  const restartedPid = startApi();
  note("restarted the API", { pid: restartedPid });
  const healthy = await waitForApiHealth(API_START_TIMEOUT_MS);
  note("API healthy again", { healthy });
  record("API came back", healthy, { pid: restartedPid });

  const finished = await pollUntil(
    page,
    (current) => current.phase === "finished",
    FINISH_TIMEOUT_MS,
    (current) => note("page", describeSnapshot(current)),
  );
  record(
    "run finishes after the restart",
    finished !== null,
    finished && describeSnapshot(finished),
  );

  const finalSnapshot = finished ?? (await snapshot(page));
  const seqs = persistedSeqs(finalSnapshot.events);
  record(
    "page events are strictly consecutive from seq 1 (no gap, no duplicate)",
    isStrictlyConsecutiveFromOne(seqs) &&
      seqs.length === expectedEvents &&
      new Set(seqs).size === seqs.length,
    { count: seqs.length, expected: expectedEvents, first: seqs[0], last: seqs.at(-1) },
  );
  record(
    "page event order is run.created, run.status_changed, ticks, hello.laya, run.finished",
    JSON.stringify(
      finalSnapshot.events.filter((event) => event.seq !== null).map((event) => event.type),
    ) ===
      JSON.stringify([
        "run.created",
        "run.status_changed",
        ...Array.from({ length: ticks }, () => "hello.tick"),
        "hello.laya",
        "run.finished",
      ]),
    { types: Array.from(new Set(finalSnapshot.events.map((event) => event.type))) },
  );
  const log = await readRunLog(context, runId);
  record(
    "the API log matches the page",
    JSON.stringify(log.map((event) => event.seq)) === JSON.stringify(seqs),
    { logCount: log.length, logHead: log.at(-1)?.seq },
  );
  const resumedFrom = timeline
    .filter((entry) => entry.message === "page")
    .map((entry) => entry.detail.lastSeq);
  note("distinct lastSeq values seen by polling", { values: Array.from(new Set(resumedFrom)) });
} else if (mode === "temporal-down") {
  await configureAndStart(3, 300);
  const unavailable = await pollUntil(
    page,
    (current) => current.phase === "unavailable",
    30_000,
    (current) => note("page", describeSnapshot(current)),
  );
  record(
    "hello page shows the unavailable state",
    unavailable !== null,
    unavailable && describeSnapshot(unavailable),
  );
  const alertText = await page
    .getByTestId("hello-unavailable")
    .innerText()
    .catch(() => "");
  record("the inline alert names Temporal", /Temporal/.test(alertText), { alertText });
  await page.waitForTimeout(1500);
  const settled = await snapshot(page);
  const toastTexts = await page.locator("[data-sonner-toast]").allInnerTexts();
  record("exactly one message for the failure (no duplicate toast)", toastTexts.length === 0, {
    toasts: toastTexts,
  });
  record("no run started", !page.url().includes("run_id="), { url: page.url() });
  note("final page", describeSnapshot(settled));
  await page.goto("/settings");
  await page.getByRole("region", { name: "Dependencies" }).waitFor();
  const temporalRow = await page
    .getByRole("region", { name: "Dependencies" })
    .getByRole("row", { name: /Temporal/ })
    .innerText();
  record("settings shows Temporal down", /Down/i.test(temporalRow), {
    temporalRow: temporalRow.replace(/\s+/g, " "),
  });
} else if (mode === "laya-down") {
  await configureAndStart(3, 300);
  const runId = await runIdFromPage();
  const finished = await pollUntil(
    page,
    (current) => current.phase === "finished" || current.phase === "failed",
    60_000,
    (current) => note("page", describeSnapshot(current)),
  );
  record(
    "run still finishes with Laya down",
    finished?.phase === "finished",
    finished && describeSnapshot(finished),
  );
  const log = await readRunLog(context, runId);
  const laya = log.find((event) => event.type === "hello.laya");
  record("hello.laya has ok false", laya?.payload.ok === false, laya?.payload);
  const seqs = log.map((event) => event.seq);
  record("log is contiguous", isStrictlyConsecutiveFromOne(seqs) && seqs.length === 2 + 3 + 1 + 1, {
    seqs,
  });
  const pageText = await page.getByTestId("hello-events").innerText();
  note("laya line on the page", {
    line: (pageText.split("\n").find((line) => /Laya/.test(line)) ?? "").slice(0, 160),
  });
} else {
  throw new Error(`unknown mode ${mode}`);
}

note("console errors captured", { count: consoleErrors.length, sample: consoleErrors.slice(0, 5) });
await browser.close();

const failed = checks.filter((check) => !check.passed);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
if (reportPath !== null) {
  writeFileSync(reportPath, JSON.stringify({ mode, checks, timeline, consoleErrors }, null, 2));
}
process.exit(failed.length === 0 ? 0 : 1);
