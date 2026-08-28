import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromClient = createRequire(resolve(here, "..", "..", "client", "package.json"));
const { chromium } = requireFromClient("@playwright/test");

const ERROR_TEXTS = [/something went wrong/i, /application error/i, /unhandled runtime error/i];
const PAGE_TIMEOUT_MS = 60000;

function readSettings(argv, env) {
  const runId = argv[2] ?? "";
  const baseUrl = (env.SMOKE_CLIENT_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const apiUrl = (env.TESSA_SMOKE_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const email = env.SMOKE_CLIENT_EMAIL ?? "admin@tessa.local";
  const password = env.SMOKE_CLIENT_PASSWORD ?? "";
  const screenshot = env.SMOKE_CLIENT_SCREENSHOT ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(runId) || password === "") {
    throw new Error("usage: SMOKE_CLIENT_PASSWORD=... node client_run_page.mjs <run id>");
  }
  return { runId, baseUrl, apiUrl, email, password, screenshot };
}

async function runTitles(page, settings) {
  const minted = await page.request.get(`${settings.baseUrl}/api/session/api-token`);
  if (minted.status() !== 200) {
    throw new Error(`the client could not mint an API token: ${minted.status()}`);
  }
  const { token } = await minted.json();
  const response = await page.request.get(`${settings.apiUrl}/api/v1/runs/${settings.runId}/scenarios?limit=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  return body.items.map((item) => item.title);
}

async function main() {
  const settings = readSettings(process.argv, process.env);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text().slice(0, 200));
    }
  });
  const failedApiCalls = [];
  page.on("response", (response) => {
    if (response.url().startsWith(settings.apiUrl) && response.status() >= 400) {
      failedApiCalls.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  try {
    await page.goto(`${settings.baseUrl}/login`, { timeout: PAGE_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: PAGE_TIMEOUT_MS });
    await page.getByLabel(/email/i).fill(settings.email);
    await page.getByLabel(/password/i).fill(settings.password);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: PAGE_TIMEOUT_MS,
      waitUntil: "commit",
    });
    const titles = await runTitles(page, settings);
    await page.goto(`${settings.baseUrl}/runs/${settings.runId}`, { timeout: PAGE_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: PAGE_TIMEOUT_MS });
    const firstTitle = titles[0] ?? "";
    if (firstTitle !== "") {
      await page.getByText(firstTitle, { exact: false }).first().waitFor({ state: "attached", timeout: PAGE_TIMEOUT_MS });
    }
    const text = (await page.locator("body").textContent()) ?? "";
    const shown = titles.filter((title) => text.includes(title));
    const errors = ERROR_TEXTS.filter((pattern) => pattern.test(text)).map(String);
    if (settings.screenshot !== "") {
      await page.screenshot({ path: settings.screenshot, fullPage: true });
    }
    const checks = {
      "run page rendered": text.includes(settings.runId.slice(0, 8)) || shown.length > 0,
      "every scenario title of the run is shown": titles.length > 0 && shown.length === titles.length,
      "no error boundary": errors.length === 0,
      "no failed API call": failedApiCalls.length === 0,
      "no console error": consoleErrors.length === 0,
    };
    process.stdout.write(
      `run page ${settings.baseUrl}/runs/${settings.runId}: ${shown.length} of ${titles.length} scenario titles shown, ` +
        `${failedApiCalls.length} failed API calls ${JSON.stringify(failedApiCalls.slice(0, 5))}, ` +
        `${consoleErrors.length} console errors ${JSON.stringify(consoleErrors.slice(0, 3))}\n`,
    );
    for (const [name, passed] of Object.entries(checks)) {
      process.stdout.write(`${passed ? "ok  " : "FAIL"} ${name}\n`);
    }
    return Object.values(checks).every(Boolean) ? 0 : 1;
  } catch (error) {
    if (settings.screenshot !== "") {
      await page.screenshot({ path: settings.screenshot, fullPage: true }).catch(() => undefined);
    }
    const firstLine = String(error?.message ?? error).split(/\r?\n/)[0];
    throw new Error(`${firstLine} (page ${page.url()})`);
  } finally {
    await browser.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`client check failed: ${String(error?.message ?? error).slice(0, 400)}\n`);
    process.exitCode = 1;
  },
);
