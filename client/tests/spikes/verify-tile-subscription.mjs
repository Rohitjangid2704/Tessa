import { writeFileSync } from "node:fs";
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
const outputPath = options.out ?? null;
const SESSIONS = 12;
const WINDOW_MS = 3000;

const checks = [];

function record(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
}

async function readHud(page) {
  const raw = await page.getByTestId("tile-hud").getAttribute("data-snapshot");
  return JSON.parse(raw ?? "{}").bus;
}

async function receivedRate(page, windowMs = WINDOW_MS) {
  const before = await readHud(page);
  await page.waitForTimeout(windowMs);
  const after = await readHud(page);
  return {
    perSecond: (after.received - before.received) / (windowMs / 1000),
    subscribed: after.subscribedTiles,
    visible: after.visibleTiles,
    pageVisible: after.pageVisible,
  };
}

async function setVisibility(page, state) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
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

const context = await browser.newContext({
  baseURL: baseUrl,
  storageState,
  viewport: { width: 1600, height: 1500 },
});
const page = await context.newPage();
await page.goto(`${tilesPath}?autostart=1&sessions=${SESSIONS}`);
await page.getByRole("list", { name: "Browser session tiles" }).waitFor({ timeout: 60_000 });
await page.waitForFunction(
  () =>
    JSON.parse(
      document.querySelector('[data-testid="tile-hud"]')?.getAttribute("data-snapshot") ?? "{}",
    ).bus?.painted > 20,
  undefined,
  { timeout: 60_000 },
);

const allVisible = await receivedRate(page);
record(
  "all 12 tiles visible: 12 subscribed and about 48 frames per second",
  allVisible.subscribed === SESSIONS && allVisible.perSecond > 40 && allVisible.perSecond < 56,
  allVisible,
);

await page.setViewportSize({ width: 1600, height: 330 });
await page.waitForTimeout(800);
const offscreen = await receivedRate(page);
record(
  "tiles below a short viewport are unsubscribed and the server sends them no frames",
  offscreen.subscribed === 0 && offscreen.visible === 0 && offscreen.perSecond < 2,
  offscreen,
);

await page.setViewportSize({ width: 1600, height: 560 });
await page.waitForTimeout(800);
const clipped = await receivedRate(page);
record(
  "one visible row subscribes only that row and the frame rate drops to match",
  clipped.subscribed >= 1 &&
    clipped.subscribed < SESSIONS &&
    clipped.perSecond < allVisible.perSecond * 0.6,
  { ...clipped, allVisibleRate: allVisible.perSecond },
);

await page.setViewportSize({ width: 1600, height: 330 });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.getByLabel("Live view of Spike session 12").scrollIntoViewIfNeeded();
await page.waitForTimeout(800);
const scrolled = await receivedRate(page);
record(
  "scrolling the last tile into view subscribes it and keeps the subscription small",
  scrolled.subscribed >= 1 && scrolled.subscribed < SESSIONS && scrolled.perSecond > 0,
  scrolled,
);
const lastTilePainted = await page.evaluate(() => {
  const canvas = document.querySelector(
    '[data-slot="screencast-canvas"][aria-label="Live view of Spike session 12"]',
  );
  if (!(canvas instanceof HTMLCanvasElement)) {
    return false;
  }
  const context2d = canvas.getContext("2d");
  const pixel = context2d?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
  return pixel !== undefined && (pixel[0] ?? 0) + (pixel[1] ?? 0) + (pixel[2] ?? 0) > 30;
});
record("the tile scrolled into view paints a frame", lastTilePainted, {});

await page.setViewportSize({ width: 1600, height: 1500 });
await page.waitForTimeout(800);
const restored = await receivedRate(page);
record(
  "restoring the viewport resubscribes every tile",
  restored.subscribed === SESSIONS && restored.perSecond > 40,
  restored,
);

await setVisibility(page, "hidden");
await page.waitForTimeout(800);
const hidden = await receivedRate(page);
record(
  "a hidden page unsubscribes everything and the stream goes quiet",
  hidden.pageVisible === false && hidden.subscribed === 0 && hidden.perSecond < 2,
  hidden,
);

await setVisibility(page, "visible");
await page.waitForTimeout(800);
const resumed = await receivedRate(page);
record(
  "a visible page resubscribes and frames resume",
  resumed.pageVisible === true && resumed.subscribed === SESSIONS && resumed.perSecond > 40,
  resumed,
);

const failed = checks.filter((check) => !check.passed);
console.log(`${checks.length - failed.length} of ${checks.length} checks passed`);
if (outputPath !== null) {
  writeFileSync(outputPath, JSON.stringify({ checks }, null, 2));
}
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
