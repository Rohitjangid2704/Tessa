import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);

const baseUrl = options.url ?? "http://localhost:3000";
const tilesPath = options.path ?? "/dev/tiles";
const email = options.email ?? process.env.E2E_USER_EMAIL ?? "admin@tessa.local";
const password = options.password ?? process.env.E2E_USER_PASSWORD ?? "dev-only-admin-password-1";
const minutes = Number(options.minutes ?? 5);
const warmupSeconds = Number(options["warmup-seconds"] ?? 20);
const sessions = Number(options.sessions ?? 12);
const sampleSeconds = Number(options["sample-seconds"] ?? 15);
const [viewportWidth, viewportHeight] = (options.viewport ?? "1600x1500").split("x").map(Number);
const headed = options.headed === "true";
const cpuThrottle = Number(options["cpu-throttle"] ?? 1);
const outputPath = options.out ?? path.join(process.cwd(), "tile-measurement.json");
const screenshotPath = options.screenshot ?? null;

const PASS_LINE = { longTasksPerMinute: 2, handlerP95Ms: 5, heapGrowthMb: 30 };
const LONG_TASK_THRESHOLD_MS = 50;
const BYTES_PER_MB = 1024 * 1024;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function forceGarbageCollection(client) {
  await client.send("HeapProfiler.collectGarbage");
  await client.send("HeapProfiler.collectGarbage");
}

async function readMetrics(client) {
  const { metrics } = await client.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

async function readHud(page) {
  const raw = await page.getByTestId("tile-hud").getAttribute("data-snapshot");
  return JSON.parse(raw ?? "{}");
}

async function readOwnLongTasks(page) {
  return page.evaluate(() => window.__measuredLongTasks ?? []);
}

const browser = await chromium.launch({
  headless: !headed,
  args: [
    "--js-flags=--expose-gc",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});

const signInContext = await browser.newContext({ baseURL: baseUrl });
const signInPage = await signInContext.newPage();
await signInPage.goto("/login");
await signInPage.getByLabel(/email/i).fill(email);
await signInPage.getByLabel(/password/i).fill(password);
await signInPage.getByRole("button", { name: /sign in|log in/i }).click();
await signInPage.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
const storageState = await signInContext.storageState();
await signInContext.close();

const context = await browser.newContext({
  baseURL: baseUrl,
  storageState,
  viewport: { width: viewportWidth, height: viewportHeight },
});
await context.addInitScript(() => {
  window.__measuredLongTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__measuredLongTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    window.__measuredLongTasks = null;
  }
});
const page = await context.newPage();
const consoleProblems = [];
page.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") {
    consoleProblems.push(`console.error: ${message.text()}`);
  }
});

const client = await context.newCDPSession(page);
await client.send("Performance.enable");
await client.send("HeapProfiler.enable");
if (cpuThrottle > 1) {
  await client.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
}

await page.goto(`${tilesPath}?autostart=1&sessions=${sessions}`);
await page.getByRole("list", { name: "Browser session tiles" }).waitFor({ timeout: 60_000 });
await page.waitForFunction(
  (expected) =>
    document.querySelectorAll('[data-slot="screencast-canvas"]').length >= expected &&
    JSON.parse(
      document.querySelector('[data-testid="tile-hud"]')?.getAttribute("data-snapshot") ?? "{}",
    ).bus?.painted > 20,
  sessions,
  { timeout: 120_000 },
);

await page.waitForTimeout(warmupSeconds * 1000);

await page.getByRole("button", { name: "Reset counters" }).click();
await forceGarbageCollection(client);
const startedAt = Date.now();
const startMetrics = await readMetrics(client);
const ownLongTasksAtStart = (await readOwnLongTasks(page))?.length ?? null;
const startHud = await readHud(page);
const startPageTime = await page.evaluate(() => performance.now());

const series = [];
const totalMs = minutes * 60_000;
while (Date.now() - startedAt < totalMs) {
  await page.waitForTimeout(sampleSeconds * 1000);
  const hud = await readHud(page);
  const metrics = await readMetrics(client);
  series.push({
    elapsedSeconds: round((Date.now() - startedAt) / 1000, 1),
    received: hud.bus.received,
    painted: hud.bus.painted,
    dropped: hud.bus.dropped,
    decodeP95Ms: round(hud.bus.decodeP95Ms),
    handlerP95Ms: round(hud.bus.handlerP95Ms),
    handlerMaxMs: round(hud.bus.handlerMaxMs),
    hudLongTasks: hud.performance.longTaskCount,
    hudHeapMb: round(hud.performance.heapUsedMb),
    cdpHeapMb: round(metrics.JSHeapUsedSize / BYTES_PER_MB),
    tiles: `${hud.bus.subscribedTiles}/${hud.bus.visibleTiles}`,
    connected: hud.bus.connected,
  });
}

const endWallSeconds = (Date.now() - startedAt) / 1000;
const endMetrics = await readMetrics(client);
const endHud = await readHud(page);
const endPageTime = await page.evaluate(() => performance.now());
const rawHeapEndMb = endMetrics.JSHeapUsedSize / BYTES_PER_MB;
await forceGarbageCollection(client);
const gcMetrics = await readMetrics(client);
const ownLongTasks = await readOwnLongTasks(page);

const startHeapMb = startMetrics.JSHeapUsedSize / BYTES_PER_MB;
const endHeapAfterGcMb = gcMetrics.JSHeapUsedSize / BYTES_PER_MB;
const windowMinutes = endWallSeconds / 60;
const longTasksInWindow =
  ownLongTasks === null
    ? null
    : ownLongTasks.filter(
        (task) => task.start >= startPageTime && task.duration > LONG_TASK_THRESHOLD_MS,
      );
const taskSeconds = endMetrics.TaskDuration - startMetrics.TaskDuration;
const scriptSeconds = endMetrics.ScriptDuration - startMetrics.ScriptDuration;
const wallSeconds = (endPageTime - startPageTime) / 1000;

const result = {
  measuredAt: new Date().toISOString(),
  mode: options.dev === "true" ? "next dev" : "production build (next start)",
  browser: browser.version(),
  headless: !headed,
  viewport: `${viewportWidth}x${viewportHeight}`,
  cpuThrottle,
  sessions,
  warmupSeconds,
  windowSeconds: round(endWallSeconds, 1),
  passLine: PASS_LINE,
  frames: {
    received: endHud.bus.received,
    painted: endHud.bus.painted,
    dropped: endHud.bus.dropped,
    decodeErrors: endHud.bus.decodeErrors,
    receivedPerSecond: round(endHud.bus.received / endWallSeconds, 1),
    paintedPerSecond: round(endHud.bus.painted / endWallSeconds, 1),
    receivedMb: round(endHud.bus.bytesReceived / BYTES_PER_MB, 1),
    acksSent: endHud.bus.acksSent,
    subscribesSent: endHud.bus.subscribesSent,
    decodeP50Ms: round(endHud.bus.decodeP50Ms),
    decodeP95Ms: round(endHud.bus.decodeP95Ms),
    decodeMaxMs: round(endHud.bus.decodeMaxMs),
    paintP95Ms: round(endHud.bus.paintP95Ms),
  },
  handler: {
    samples: endHud.bus.handlerSamples,
    p95Ms: round(endHud.bus.handlerP95Ms),
    maxMs: round(endHud.bus.handlerMaxMs),
  },
  longTasks: {
    observerAvailable: ownLongTasks !== null,
    countOverThreshold: longTasksInWindow === null ? null : longTasksInWindow.length,
    perMinute: longTasksInWindow === null ? null : round(longTasksInWindow.length / windowMinutes),
    longestMs:
      longTasksInWindow === null
        ? null
        : round(Math.max(0, ...longTasksInWindow.map((task) => task.duration)), 1),
    hudCount: endHud.performance.longTaskCount,
    hudPerMinute: round(endHud.performance.longTasksPerMinute),
    tasks: (longTasksInWindow ?? []).map((task) => ({
      atSeconds: round((task.start - startPageTime) / 1000, 1),
      durationMs: round(task.duration, 1),
    })),
    initialCountBeforeWindow: ownLongTasksAtStart,
  },
  heap: {
    afterGcStartMb: round(startHeapMb),
    afterGcEndMb: round(endHeapAfterGcMb),
    afterGcGrowthMb: round(endHeapAfterGcMb - startHeapMb),
    rawEndMb: round(rawHeapEndMb),
    rawGrowthMb: round(rawHeapEndMb - startHeapMb),
    hudStartMb: round(startHud.performance.heapUsedMb),
    hudEndMb: round(endHud.performance.heapUsedMb),
    hudPeakMb: round(endHud.performance.heapPeakMb),
  },
  mainThread: {
    busyPercent: round((taskSeconds / wallSeconds) * 100, 1),
    scriptPercent: round((scriptSeconds / wallSeconds) * 100, 1),
  },
  consoleProblems,
  series,
};

const verdict = {
  longTasks:
    result.longTasks.perMinute === null
      ? "unmeasured"
      : result.longTasks.perMinute <= PASS_LINE.longTasksPerMinute,
  handlerP95: result.handler.p95Ms < PASS_LINE.handlerP95Ms,
  heapGrowthAfterGc: result.heap.afterGcGrowthMb < PASS_LINE.heapGrowthMb,
  heapGrowthRaw: result.heap.rawGrowthMb < PASS_LINE.heapGrowthMb,
  noDecodeErrors: result.frames.decodeErrors === 0,
  noConsoleProblems: consoleProblems.length === 0,
};
result.verdict = {
  ...verdict,
  pass:
    verdict.longTasks === true &&
    verdict.handlerP95 &&
    verdict.heapGrowthAfterGc &&
    verdict.noDecodeErrors,
};

if (screenshotPath !== null) {
  await page.screenshot({ path: screenshotPath, fullPage: true });
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({ ...result, series: `${series.length} samples (see ${outputPath})` }, null, 2),
);

await browser.close();
