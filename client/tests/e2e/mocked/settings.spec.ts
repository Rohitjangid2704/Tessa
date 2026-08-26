import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { expectNoAxeViolations } from "../helpers/axe";
import { apiOrigin } from "../helpers/env";
import { signInThroughForm } from "../helpers/login";
import { clearMockFaults, resetMockApi, setMockFaults } from "../helpers/mock-api";

test.describe("settings diagnostics", () => {
  test.beforeEach(async ({ request }) => {
    await resetMockApi(request);
  });

  test.afterEach(async ({ request }) => {
    await clearMockFaults(request);
  });

  test("shows liveness, every dependency and the published schemas", async ({ page, request }) => {
    await page.goto("/settings");

    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByText("The API is responding.")).toBeVisible();

    const dependencies = page.getByRole("region", { name: "Dependencies" });
    await expect(dependencies.getByRole("row", { name: /Database/ })).toContainText("Up");
    await expect(dependencies.getByRole("row", { name: /Temporal/ })).toContainText("Up");
    await expect(dependencies.getByRole("row", { name: /Laya/ })).toContainText("Up");
    await expect(dependencies.getByRole("row", { name: /Storage/ })).toContainText("Unconfigured");
    await expect(dependencies.getByRole("alert")).toHaveCount(0);

    const bundleLink = page.getByRole("link", { name: "bundle.v1.json" });
    await expect(bundleLink).toBeVisible();
    const href = await bundleLink.getAttribute("href");
    expect(href).toBe(`${apiOrigin()}/schemas/bundle.v1.json`);
    const response = await request.get(href ?? "");
    expect(response.status()).toBe(200);
  });

  test("shows a skeleton while the API is slow", async ({ page, request }) => {
    await setMockFaults(request, { latency_ms: 1500 });
    await page.goto("/settings");

    await expect(page.getByText("Checking the API")).toBeAttached();
    await expect(page.getByText("Checking dependencies")).toBeAttached();
    await expect(page.getByText("Loading the schema index")).toBeAttached();

    await expect(page.getByText("The API is responding.")).toBeVisible();
    await expect(page.getByRole("row", { name: /Database/ })).toBeVisible();
    await expect(page.getByText("Checking dependencies")).toHaveCount(0);
  });

  test("marks a failing dependency down and recovers when it is back", async ({
    page,
    request,
  }) => {
    await setMockFaults(request, { dependencies_down: ["temporal"] });
    await page.goto("/settings");

    const dependencies = page.getByRole("region", { name: "Dependencies" });
    const temporal = dependencies.getByRole("row", { name: /Temporal/ });
    await expect(temporal).toContainText("Down");
    await expect(dependencies.getByRole("row", { name: /Database/ })).toContainText("Up");
    await expect(dependencies.getByRole("alert")).toContainText("1 dependency is down");
    await expect(dependencies.getByRole("alert")).toContainText("Temporal");
    await expect(page.getByText("The API is responding.")).toBeVisible();

    await clearMockFaults(request);
    await dependencies.getByRole("button", { name: "Refresh dependency status" }).click();

    await expect(temporal).toContainText("Up");
    await expect(dependencies.getByRole("alert")).toHaveCount(0);
  });

  test("shows one error with a retry when the API is unreachable", async ({ page }) => {
    await page.route("**/health", (route) => route.abort("connectionrefused"));
    await page.goto("/settings");

    await expect(page.getByRole("heading", { name: "The API is not reachable" })).toBeVisible();
    await expect(page.getByRole("main").getByText(/Cannot reach the Tessa API/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Dependencies" })).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

    await page.unroute("**/health");
    await page.getByRole("button", { name: /^Retry/ }).click();

    await expect(page.getByText("The API is responding.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "The API is not reachable" })).toHaveCount(0);
    await expect(page.getByRole("row", { name: /Database/ })).toBeVisible();
  });
});

const SETTLE_TIMEOUT_MS = 15_000;
const RELOADS = 12;
const FAILED_RESOURCE_LOG = "Failed to load resource";
const TYPED_KEY = "dev-only-e2e-settings-key-8d41c7";
const TYPED_WEBHOOK_TOKEN = "dev-only-e2e-webhook-token-2b6f90";
const TYPED_WEBHOOK = `https://hooks.slack.test/services/${TYPED_WEBHOOK_TOKEN}`;
const VIEWER = { email: "viewer@tessa.local", password: "dev-only-viewer-password-1" };
const MEMBER = { email: "member@tessa.local", password: "dev-only-member-password-1" };

interface SentRequest {
  method: string;
  path: string;
  body: string;
}

interface RecordedWindow {
  __settingsRequests: SentRequest[];
}

type SettingsSeed = "default" | "overridden" | "unconfigured";

function region(page: Page, name: string): Locator {
  return page.getByRole("region", { name, exact: true });
}

function modelRow(page: Page, role: string): Locator {
  return page.locator(`[data-role="${role}"]`);
}

function leaf(page: Page, dotted: string): Locator {
  return page.locator(`[data-leaf="${dotted}"]`);
}

function secretRow(page: Page, name: string): Locator {
  return page.locator(`[data-secret="${name}"]`);
}

function serviceRow(page: Page, service: string): Locator {
  return page.locator(`[data-service="${service}"]`);
}

function saveButton(scope: Locator): Locator {
  return scope.getByRole("button", { name: "Save changes" });
}

function field(page: Page, label: string): Locator {
  return page.getByLabel(label, { exact: true });
}

async function recordSettingsRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorded: Array<{ method: string; path: string; body: string }> = [];
    Object.defineProperty(window, "__settingsRequests", { value: recorded });
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (input instanceof Request && input.method !== "GET") {
        const { pathname } = new URL(input.url);
        if (pathname.startsWith("/api/v1/settings")) {
          recorded.push({
            method: input.method,
            path: pathname,
            body: await input.clone().text(),
          });
        }
      }
      return original(input, init);
    };
  });
}

async function sentRequests(page: Page, method: string): Promise<SentRequest[]> {
  await page.waitForFunction(
    (wanted) =>
      (window as unknown as RecordedWindow).__settingsRequests.some(
        (request) => request.method === wanted,
      ),
    method,
  );
  return page.evaluate(
    (wanted) =>
      (window as unknown as RecordedWindow).__settingsRequests.filter(
        (request) => request.method === wanted,
      ),
    method,
  );
}

async function sentPatches(page: Page): Promise<unknown[]> {
  return (await sentRequests(page, "PATCH")).map((request) => JSON.parse(request.body) as unknown);
}

async function openSettings(page: Page): Promise<void> {
  await recordSettingsRequests(page);
  await page.goto("/settings");
  await expect(region(page, "Models and effort")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
  await expect(field(page, "Judge model")).toBeVisible();
}

async function openEditableSettings(page: Page): Promise<void> {
  await openSettings(page);
  await expect(field(page, "Judge model")).toBeEnabled({ timeout: SETTLE_TIMEOUT_MS });
  await expect(page.getByRole("button", { name: "Test Laya connection" })).toBeEnabled();
}

async function seedSettings(request: APIRequestContext, settings: SettingsSeed): Promise<void> {
  const response = await request.post(`${apiOrigin()}/__mock/stage4/seed`, { data: { settings } });
  expect(response.ok()).toBe(true);
}

function collectResponseBodies(page: Page): () => Promise<string[]> {
  const pending: Promise<string>[] = [];
  page.on("response", (response) => {
    pending.push(response.text().catch(() => ""));
  });
  return () => Promise.all(pending);
}

async function inputValues(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("input")).map((element) => element.value),
  );
}

async function storageText(page: Page): Promise<string> {
  return page.evaluate(() =>
    JSON.stringify([
      Object.entries(window.localStorage),
      Object.entries(window.sessionStorage),
      document.cookie,
    ]),
  );
}

async function expectNoSecretIn(page: Page, secrets: readonly string[]): Promise<void> {
  for (const secret of secrets) {
    await expect(page.locator("body")).not.toContainText(secret);
    expect((await page.content()).includes(secret)).toBe(false);
    expect((await inputValues(page)).filter((value) => value.includes(secret))).toEqual([]);
    expect((await storageText(page)).includes(secret)).toBe(false);
  }
}

let pageErrors: string[] = [];

function registerCleanPageHooks(): void {
  test.beforeEach(async ({ page, request }) => {
    pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith(FAILED_RESOURCE_LOG)) {
        pageErrors.push(message.text());
      }
    });
    await resetMockApi(request);
  });

  test.afterEach(async ({ request }) => {
    await clearMockFaults(request);
    expect(pageErrors).toEqual([]);
  });
}

test.describe("settings sections", () => {
  registerCleanPageHooks();

  test("shows every section, seven roles and the env defaults for an admin", async ({ page }) => {
    await openEditableSettings(page);

    for (const name of [
      "Models and effort",
      "Thresholds",
      "Endpoints",
      "Budgets",
      "Secrets",
      "Connectivity tests",
    ]) {
      await expect(region(page, name)).toBeVisible();
    }
    await expect(page.locator("[data-role]")).toHaveCount(7);
    await expect(modelRow(page, "judge")).toHaveAttribute("data-source", "env");
    await expect(field(page, "Judge model")).toHaveValue("gpt-5-mini");
    await expect(page.getByRole("combobox", { name: "Judge effort" })).toHaveText(/low/);
    await expect(field(page, "Probe confidence")).toHaveValue("0.75");
    await expect(field(page, "Laya URL")).toHaveValue("http://127.0.0.1:7006");
    await expect(field(page, "Jev URL")).toHaveValue("");
    await expect(field(page, "Default max cost in USD")).toHaveValue("5");
    await expect(page.getByRole("button", { name: /Reset to default/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Dependencies" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Schemas" })).toBeVisible();
  });

  test("edits a model, an effort and a threshold, saves, and a reload shows them with source db", async ({
    page,
  }) => {
    await openEditableSettings(page);
    const models = region(page, "Models and effort");
    const thresholds = region(page, "Thresholds");

    await field(page, "Judge model").fill("gpt-5.2-judge");
    await page.getByRole("combobox", { name: "Judge effort" }).click();
    await page.getByRole("option", { name: "high", exact: true }).click();
    await expect(models.getByText("2 unsaved changes")).toBeVisible();
    await saveButton(models).click();
    await expect(models.getByText("2 settings saved.")).toBeVisible();
    await field(page, "Probe confidence").fill("0.8");
    await saveButton(thresholds).click();
    await expect(thresholds.getByText("1 setting saved.")).toBeVisible();

    expect(await sentPatches(page)).toEqual([
      { models: { judge: { model: "gpt-5.2-judge", effort: "high" } } },
      { thresholds: { probe_confidence: 0.8 } },
    ]);
    await expect(modelRow(page, "judge")).toHaveAttribute("data-source", "db");
    await expect(modelRow(page, "generate")).toHaveAttribute("data-source", "env");

    await page.reload();
    await expect(field(page, "Judge model")).toHaveValue("gpt-5.2-judge", {
      timeout: SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByRole("combobox", { name: "Judge effort" })).toHaveText(/high/);
    await expect(field(page, "Probe confidence")).toHaveValue("0.8");
    await expect(modelRow(page, "judge")).toHaveAttribute("data-source", "db");
    await expect(modelRow(page, "judge").getByText("DB override")).toBeVisible();
    await expect(modelRow(page, "generate")).toHaveAttribute("data-source", "env");
    await expect(leaf(page, "thresholds.probe_confidence").getByText("DB override")).toBeVisible();
    await expect(leaf(page, "thresholds.label_audit_rate").getByText("Env default")).toBeVisible();
  });

  test("saves endpoints and budgets with numbers, and sets and removes the Jev URL", async ({
    page,
  }) => {
    await openEditableSettings(page);
    const endpoints = region(page, "Endpoints");
    const budgets = region(page, "Budgets");

    await field(page, "Jev URL").fill("https://jev.qa.example.test");
    await saveButton(endpoints).click();
    await expect(endpoints.getByText("1 setting saved.")).toBeVisible();
    await field(page, "Default max cost in USD").fill("12.5");
    await field(page, "Max concurrency").fill("8");
    await saveButton(budgets).click();
    await expect(budgets.getByText("2 settings saved.")).toBeVisible();
    await field(page, "Jev URL").fill("");
    await saveButton(endpoints).click();
    await expect(endpoints.getByText("1 setting reset to default.")).toBeVisible();

    expect(await sentPatches(page)).toEqual([
      { endpoints: { jev_url: "https://jev.qa.example.test" } },
      { budgets: { default_max_usd: 12.5, max_concurrency: 8 } },
      { endpoints: { jev_url: null } },
    ]);
    await expect(field(page, "Jev URL")).toHaveValue("");
    await expect(leaf(page, "endpoints.jev_url").getByText("Env default")).toBeVisible();
  });

  test("offers Reset to default only on overridden leaves and saves it as null", async ({
    page,
    request,
  }) => {
    await seedSettings(request, "overridden");
    await openEditableSettings(page);
    const judge = modelRow(page, "judge");
    const models = region(page, "Models and effort");

    await expect(judge).toHaveAttribute("data-source", "db");
    await expect(judge.getByRole("button", { name: /Reset to default/ })).toHaveCount(2);
    await expect(page.getByRole("button", { name: /Reset to default for Generate/ })).toHaveCount(
      0,
    );
    await judge.getByRole("button", { name: "Reset to default for Judge effort" }).click();
    await expect(judge.getByText("Default on save")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Judge effort" })).toBeDisabled();
    await expect(models.getByText("1 unsaved change")).toBeVisible();
    await saveButton(models).click();

    await expect(models.getByText("1 setting reset to default.")).toBeVisible();
    expect(await sentPatches(page)).toEqual([{ models: { judge: { effort: null } } }]);
    await expect(page.getByRole("combobox", { name: "Judge effort" })).toHaveText(/low/);
    await expect(judge.getByRole("button", { name: /Reset to default/ })).toHaveCount(1);
    await expect(judge).toHaveAttribute("data-source", "db");

    await judge.getByRole("button", { name: "Reset to default for Judge max USD" }).click();
    await saveButton(models).click();
    await expect(judge).toHaveAttribute("data-source", "env");
    await expect(judge.getByRole("button", { name: /Reset to default/ })).toHaveCount(0);
    await expect(field(page, "Judge max USD")).toHaveValue("0.05");
  });

  test("resets the Jev URL and a threshold to what the environment gives", async ({
    page,
    request,
  }) => {
    await seedSettings(request, "overridden");
    await openEditableSettings(page);
    await expect(field(page, "Jev URL")).toHaveValue("https://jev.qa.example.test");
    await expect(field(page, "Probe confidence")).toHaveValue("0.8");

    await leaf(page, "endpoints.jev_url")
      .getByRole("button", { name: /Reset to default/ })
      .click();
    await saveButton(region(page, "Endpoints")).click();
    await leaf(page, "thresholds.probe_confidence")
      .getByRole("button", { name: /Reset to default/ })
      .click();
    await saveButton(region(page, "Thresholds")).click();

    await expect(field(page, "Jev URL")).toHaveValue("");
    await expect(field(page, "Probe confidence")).toHaveValue("0.75");
    expect(await sentPatches(page)).toEqual([
      { endpoints: { jev_url: null } },
      { thresholds: { probe_confidence: null } },
    ]);
  });

  test("validates before sending and keeps the page from posting invalid values", async ({
    page,
  }) => {
    await openEditableSettings(page);
    const thresholds = region(page, "Thresholds");
    const sent: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PATCH") {
        sent.push(request.url());
      }
    });

    await field(page, "Probe confidence").fill("1.5");
    await field(page, "Label audit rate").fill("often");
    await saveButton(thresholds).click();

    await expect(thresholds.getByText("Enter a number from 0 to 1")).toHaveCount(2);
    await expect(field(page, "Probe confidence")).toHaveAttribute("aria-invalid", "true");
    expect(sent).toEqual([]);
  });

  test("shows the server's 422 message on the model field and keeps what was typed", async ({
    page,
  }) => {
    await openEditableSettings(page);
    const generate = modelRow(page, "generate");

    await field(page, "Generate model").fill("bad model!");
    await saveButton(region(page, "Models and effort")).click();

    await expect(generate.getByText(/Model names use letters, digits, dot/)).toBeVisible();
    await expect(field(page, "Generate model")).toHaveValue("bad model!");
    await expect(field(page, "Generate model")).toHaveAttribute("aria-invalid", "true");
    await expect(generate).toHaveAttribute("data-source", "env");

    await field(page, "Generate model").fill("gpt-5.2-pro");
    await expect(generate.getByText(/Model names use letters/)).toHaveCount(0);
    await saveButton(region(page, "Models and effort")).click();
    await expect(region(page, "Models and effort").getByText("1 setting saved.")).toBeVisible();
  });

  test("maps the settings_422 fault to the leaf that was sent", async ({ page, request }) => {
    await setMockFaults(request, { settings_422: true });
    await openEditableSettings(page);
    const budgets = region(page, "Budgets");

    await field(page, "Max concurrency").fill("9");
    await saveButton(budgets).click();

    await expect(
      leaf(page, "budgets.max_concurrency").getByText(
        "The mock fault settings_422 rejected this value",
      ),
    ).toBeVisible();
    await expect(field(page, "Max concurrency")).toHaveValue("9");
    await expect(budgets.getByText(/Could not save/)).toHaveCount(0);

    await clearMockFaults(request);
    await saveButton(budgets).click();
    await expect(budgets.getByText("1 setting saved.")).toBeVisible();
  });

  test("shows one error with a retry and the request id when the settings cannot load", async ({
    page,
  }) => {
    await page.route("**/api/v1/settings", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "internal_error",
            message: "Boom",
            request_id: "req-e2e-settings",
            details: [],
          },
        }),
      });
    });
    await page.goto("/settings");

    await expect(
      page.getByRole("main").getByRole("heading", { name: "Could not load the settings" }),
    ).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(page.getByText("Request ID: req-e2e-settings")).toBeVisible();
    await expect(page.getByText("The API is responding.")).toBeVisible();
    await expect(region(page, "Models and effort")).toHaveCount(0);

    await page.unroute("**/api/v1/settings");
    await page.getByRole("button", { name: /^Retry/ }).click();

    await expect(region(page, "Models and effort")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Could not load the settings" })).toHaveCount(0);
  });
});

test.describe("settings secrets", () => {
  registerCleanPageHooks();

  test("shows the five keys in mixed states and never a value", async ({ page }) => {
    await openEditableSettings(page);

    await expect(page.locator("[data-secret]")).toHaveCount(5);
    await expect(secretRow(page, "openai_api_key")).toHaveAttribute("data-has-value", "true");
    await expect(
      secretRow(page, "openai_api_key").getByText("From environment", { exact: true }),
    ).toBeVisible();
    await expect(
      secretRow(page, "anthropic_api_key").getByText("Stored in Tessa", { exact: true }),
    ).toBeVisible();
    await expect(secretRow(page, "jev_api_key")).toHaveAttribute("data-has-value", "false");
    await expect(secretRow(page, "slack_webhook_url")).toHaveAttribute("data-has-value", "false");
    await expect(secretRow(page, "smtp_password")).toHaveAttribute("data-has-value", "true");
    await expect(page.locator("input[type=password]")).toHaveCount(0);
  });

  test("sets a key and clears it again, write-only throughout", async ({ page }) => {
    await openEditableSettings(page);
    const jev = secretRow(page, "jev_api_key");

    await jev.getByRole("button", { name: "Set key Jev API key" }).click();
    const input = jev.getByLabel("New value for Jev API key");
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await input.fill(TYPED_KEY);
    await jev.getByRole("button", { name: "Save key" }).click();

    await expect(
      jev.getByText("Jev API key saved. It is stored write-only and never shown again."),
    ).toBeVisible();
    await expect(jev).toHaveAttribute("data-has-value", "true");
    await expect(jev.getByText("Stored in Tessa", { exact: true })).toBeVisible();
    await expect(jev.locator("input")).toHaveCount(0);
    const [put] = await sentRequests(page, "PUT");
    expect(put?.path).toBe("/api/v1/settings/secrets/jev_api_key");
    expect(JSON.parse(put?.body ?? "null")).toEqual({ value: TYPED_KEY });

    await jev.getByRole("button", { name: "Clear Jev API key" }).click();
    await page
      .getByRole("alertdialog", { name: "Clear the Jev API key?" })
      .getByRole("button", { name: "Clear key" })
      .click();

    await expect(jev.getByText("Jev API key cleared.")).toBeVisible();
    await expect(jev).toHaveAttribute("data-has-value", "false");
    await expect(jev.getByText("Not set", { exact: true })).toBeVisible();
    const [deleted] = await sentRequests(page, "DELETE");
    expect(deleted?.path).toBe("/api/v1/settings/secrets/jev_api_key");
  });

  test("a stored key falls back to the environment value when it is cleared", async ({ page }) => {
    await openEditableSettings(page);
    const openai = secretRow(page, "openai_api_key");
    await expect(openai.getByRole("button", { name: /^Clear/ })).toHaveCount(0);

    await openai.getByRole("button", { name: "Replace OpenAI API key" }).click();
    await openai.getByLabel("New value for OpenAI API key").fill(TYPED_KEY);
    await openai.getByRole("button", { name: "Save key" }).click();
    await expect(openai.getByText("Stored in Tessa", { exact: true })).toBeVisible();
    await openai.getByRole("button", { name: "Clear OpenAI API key" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Clear key" }).click();

    await expect(openai.getByText("OpenAI API key cleared.")).toBeVisible();
    await expect(openai.getByText("From environment", { exact: true })).toBeVisible();
    await expect(openai).toHaveAttribute("data-has-value", "true");
  });

  test("a typed secret appears in no response body, DOM text, input value or storage", async ({
    page,
  }) => {
    const bodies = collectResponseBodies(page);
    await openEditableSettings(page);
    const jev = secretRow(page, "jev_api_key");
    const slack = secretRow(page, "slack_webhook_url");

    await jev.getByRole("button", { name: "Set key Jev API key" }).click();
    await jev.getByLabel("New value for Jev API key").fill(TYPED_KEY);
    await jev.getByRole("button", { name: "Save key" }).click();
    await expect(jev.getByText(/saved\. It is stored write-only/)).toBeVisible();
    await slack.getByRole("button", { name: "Set key Slack webhook URL" }).click();
    await slack.getByLabel("New value for Slack webhook URL").fill(TYPED_WEBHOOK);
    await slack.getByRole("button", { name: "Save key" }).click();
    await expect(slack.getByText(/saved\. It is stored write-only/)).toBeVisible();
    await page.getByRole("button", { name: "Test Jev connection" }).click();
    await expect(serviceRow(page, "jev")).not.toHaveAttribute("data-state", "idle");

    const sent = await sentRequests(page, "PUT");
    expect(sent.map((request) => request.body).join(" ")).toContain(TYPED_KEY);
    expect(sent.map((request) => request.body).join(" ")).toContain(TYPED_WEBHOOK_TOKEN);
    await expectNoSecretIn(page, [TYPED_KEY, TYPED_WEBHOOK_TOKEN, TYPED_WEBHOOK]);

    await page.reload();
    await expect(secretRow(page, "jev_api_key")).toHaveAttribute("data-has-value", "true", {
      timeout: SETTLE_TIMEOUT_MS,
    });

    const responses = await bodies();
    expect(responses.length).toBeGreaterThan(5);
    for (const secret of [TYPED_KEY, TYPED_WEBHOOK_TOKEN, TYPED_WEBHOOK]) {
      expect(responses.filter((text) => text.includes(secret))).toEqual([]);
    }
    await expectNoSecretIn(page, [TYPED_KEY, TYPED_WEBHOOK_TOKEN, TYPED_WEBHOOK]);
  });

  test("the input is already empty while the key is being saved", async ({ page }) => {
    await page.route("**/api/v1/settings/secrets/*", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fallback();
    });
    await openEditableSettings(page);
    const jev = secretRow(page, "jev_api_key");
    await jev.getByRole("button", { name: "Set key Jev API key" }).click();
    const input = jev.getByLabel("New value for Jev API key");
    await input.fill(TYPED_KEY);

    await jev.getByRole("button", { name: "Save key" }).click();

    await expect(input).toBeDisabled();
    await expect(input).toHaveValue("");
    await expect(jev.getByRole("button", { name: "Saving" })).toBeDisabled();
    await expectNoSecretIn(page, [TYPED_KEY]);
    await expect(jev.getByText(/saved\. It is stored write-only/)).toBeVisible();
  });

  test("shows a rejected key without keeping what was typed", async ({ page }) => {
    await openEditableSettings(page);
    const slack = secretRow(page, "slack_webhook_url");
    await slack.getByRole("button", { name: "Set key Slack webhook URL" }).click();

    await slack.getByLabel("New value for Slack webhook URL").fill("http://hooks.slack.test/x");
    await slack.getByRole("button", { name: "Save key" }).click();

    await expect(slack.getByText("A Slack webhook is an https URL")).toBeVisible();
    await expect(slack.getByLabel("New value for Slack webhook URL")).toHaveValue("");
    await expect(slack).toHaveAttribute("data-has-value", "false");
  });
});

test.describe("settings connectivity tests", () => {
  registerCleanPageHooks();

  test("tests a service: running, then ok with the latency", async ({ page, request }) => {
    await setMockFaults(request, { health_slow: 1200 });
    await openEditableSettings(page);
    const laya = serviceRow(page, "laya");
    await expect(page.locator("[data-service]")).toHaveCount(5);

    await page.getByRole("button", { name: "Test Laya connection" }).click();

    await expect(laya).toHaveAttribute("data-state", "running");
    await expect(laya.getByRole("status")).toHaveText("Testing");
    await expect(page.getByRole("button", { name: "Testing Laya connection" })).toBeDisabled();
    await expect(serviceRow(page, "temporal")).toHaveAttribute("data-state", "idle");
    await expect(laya).toHaveAttribute("data-state", "ok", { timeout: SETTLE_TIMEOUT_MS });
    await expect(laya.getByText("OK", { exact: true })).toBeVisible();
    await expect(laya.getByText("12 ms")).toBeVisible();
  });

  test("reports a failed service with its message, then ok once it is back", async ({
    page,
    request,
  }) => {
    await setMockFaults(request, { service_test_fail: ["openai"] });
    await openEditableSettings(page);
    const openai = serviceRow(page, "openai");

    await page.getByRole("button", { name: "Test OpenAI connection" }).click();

    await expect(openai).toHaveAttribute("data-state", "failed");
    await expect(openai.getByText("Failed", { exact: true })).toBeVisible();
    await expect(openai.getByText("The provider answered 401 Unauthorized")).toBeVisible();

    await clearMockFaults(request);
    await page.getByRole("button", { name: "Test OpenAI connection" }).click();

    await expect(openai).toHaveAttribute("data-state", "ok");
    await expect(openai.getByText("The provider answered 401 Unauthorized")).toHaveCount(0);
  });

  test("reports a service without a key or URL as not configured", async ({ page }) => {
    await openEditableSettings(page);

    await page.getByRole("button", { name: "Test Jev connection" }).click();

    await expect(serviceRow(page, "jev")).toHaveAttribute("data-state", "failed");
    await expect(serviceRow(page, "jev").getByText("not configured")).toBeVisible();
  });

  test("follows a dependency that is down", async ({ page, request }) => {
    await setMockFaults(request, { dependencies_down: ["temporal"] });
    await openEditableSettings(page);

    await page.getByRole("button", { name: "Test Temporal connection" }).click();

    await expect(serviceRow(page, "temporal")).toHaveAttribute("data-state", "failed");
    await expect(serviceRow(page, "temporal").getByText(/did not answer/)).toBeVisible();
  });
});

test.describe("settings unsaved changes", () => {
  test.beforeEach(async ({ request }) => {
    await resetMockApi(request);
  });

  test("asks before an in-app link leaves with unsaved edits, and not otherwise", async ({
    page,
  }) => {
    await openEditableSettings(page);
    const nav = page.getByRole("navigation", { name: "Main" });
    const dialog = page.getByRole("alertdialog", { name: "Leave without saving?" });

    await field(page, "Max concurrency").fill("8");
    await nav.getByRole("link", { name: "Targets" }).click();

    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(field(page, "Max concurrency")).toHaveValue("8");

    await nav.getByRole("link", { name: "Targets" }).click();
    await dialog.getByRole("button", { name: "Discard and leave" }).click();

    await expect(page).toHaveURL(/\/targets/);
  });

  test("lets the page go once the edits are saved or discarded", async ({ page }) => {
    await openEditableSettings(page);
    const budgets = region(page, "Budgets");
    const nav = page.getByRole("navigation", { name: "Main" });

    await field(page, "Max concurrency").fill("8");
    await budgets.getByRole("button", { name: "Discard changes" }).click();
    await field(page, "Default max minutes").fill("45");
    await saveButton(budgets).click();
    await expect(budgets.getByText("1 setting saved.")).toBeVisible();
    await nav.getByRole("link", { name: "Targets" }).click();

    await expect(page).toHaveURL(/\/targets/);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("raises the browser's leave warning only while something is unsaved", async ({ page }) => {
    await openEditableSettings(page);
    await field(page, "Max concurrency").fill("8");

    const dialogPromise = page.waitForEvent("dialog");
    await page.close({ runBeforeUnload: true });
    const dialog = await dialogPromise;

    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
    expect(page.isClosed()).toBe(false);
    await expect(field(page, "Max concurrency")).toHaveValue("8");
  });
});

test.describe("settings without the admin role", () => {
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

  test.beforeEach(async ({ request }) => {
    await resetMockApi(request);
  });

  for (const [name, account] of [
    ["viewer", VIEWER],
    ["member", MEMBER],
  ] as const) {
    test(`shows every value read-only to a ${name}`, async ({ page, request }) => {
      await seedSettings(request, "overridden");
      await page.goto("/login");
      await signInThroughForm(page, account);
      await openSettings(page);

      await expect(page.getByText(/You have read-only access/)).toBeVisible();
      await expect(page.getByRole("button", { name: /Save changes|Discard changes/ })).toHaveCount(
        0,
      );
      await expect(page.getByRole("button", { name: /Reset to default/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^(Replace|Set key|Clear) / })).toHaveCount(0);
      await expect(field(page, "Judge model")).toHaveAttribute("readonly", "");
      await expect(field(page, "Judge model")).toHaveValue("gpt-5-mini");
      await expect(page.getByRole("combobox", { name: "Judge effort" })).toBeDisabled();
      await expect(page.getByRole("combobox", { name: "Judge effort" })).toHaveText(/high/);
      await expect(modelRow(page, "judge")).toHaveAttribute("data-source", "db");
      await expect(field(page, "Probe confidence")).toHaveAttribute("readonly", "");
      await expect(
        leaf(page, "thresholds.probe_confidence").getByText("DB override"),
      ).toBeVisible();
      await expect(secretRow(page, "openai_api_key")).toHaveAttribute("data-has-value", "true");
      await expect(secretRow(page, "jev_api_key")).toHaveAttribute("data-has-value", "false");
      for (const button of await region(page, "Connectivity tests").getByRole("button").all()) {
        await expect(button).toBeDisabled();
      }
    });
  }
});

test.describe("settings hydration", () => {
  test.beforeEach(async ({ request }) => {
    await resetMockApi(request);
  });

  test("never leaves a control stuck after a reload", async ({ page }) => {
    for (let attempt = 0; attempt < RELOADS; attempt += 1) {
      await page.goto("/settings");
      await expect(field(page, "Judge model")).toBeEnabled({ timeout: SETTLE_TIMEOUT_MS });
      await expect(page.getByRole("button", { name: "Test Laya connection" })).toBeEnabled({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(
        region(page, "Budgets").getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
      await expect(
        secretRow(page, "jev_api_key").getByRole("button", { name: "Set key Jev API key" }),
      ).toBeEnabled();
    }
  });
});

const colorSchemes = ["light", "dark"] as const;

async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

async function expectTheme(page: Page, scheme: (typeof colorSchemes)[number]) {
  const html = page.locator("html");
  if (scheme === "dark") {
    await expect(html).toHaveClass(/\bdark\b/);
  } else {
    await expect(html).not.toHaveClass(/\bdark\b/);
  }
}

for (const scheme of colorSchemes) {
  test.describe(`axe on the settings page in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test.beforeEach(async ({ request }) => {
      await resetMockApi(request);
    });

    test.afterEach(async ({ request }) => {
      await clearMockFaults(request);
    });

    test("loaded, with overrides and every section", async ({ page, request }) => {
      await seedSettings(request, "overridden");
      await openEditableSettings(page);
      await expectTheme(page, scheme);

      await expectNoAxeViolations(page);
    });

    test("with edits, validation errors and a staged reset", async ({ page, request }) => {
      await seedSettings(request, "overridden");
      await openEditableSettings(page);
      await field(page, "Probe confidence").fill("1.5");
      await field(page, "Laya URL").fill("laya");
      await field(page, "Judge max USD").fill("lots");
      await modelRow(page, "judge")
        .getByRole("button", { name: "Reset to default for Judge effort" })
        .click();
      await saveButton(region(page, "Thresholds")).click();
      await saveButton(region(page, "Endpoints")).click();
      await saveButton(region(page, "Models and effort")).click();
      await expect(page.getByText("Enter a number from 0 to 1")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("with a server 422 on a model and a save error", async ({ page }) => {
      await openEditableSettings(page);
      await field(page, "Generate model").fill("bad model!");
      await saveButton(region(page, "Models and effort")).click();
      await expect(page.getByText(/Model names use letters/)).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("with the effort list open, scanning the list itself", async ({ page }) => {
      await openEditableSettings(page);
      await page.getByRole("combobox", { name: "Judge effort" }).click();
      await expect(page.getByRole("option", { name: "high", exact: true })).toBeVisible();
      await settleAnimations(page);

      await expectNoAxeViolations(page, { include: "[role=listbox]" });
    });

    test("with a key editor open and a clear confirmation", async ({ page }) => {
      await openEditableSettings(page);
      await secretRow(page, "jev_api_key")
        .getByRole("button", { name: "Set key Jev API key" })
        .click();
      await expect(
        secretRow(page, "jev_api_key").getByLabel("New value for Jev API key"),
      ).toBeVisible();

      await expectNoAxeViolations(page);

      await secretRow(page, "jev_api_key").getByRole("button", { name: "Cancel" }).click();
      await secretRow(page, "anthropic_api_key")
        .getByRole("button", { name: "Clear Anthropic API key" })
        .click();
      await expect(
        page.getByRole("alertdialog", { name: "Clear the Anthropic API key?" }),
      ).toBeVisible();
      await settleAnimations(page);

      await expectNoAxeViolations(page);
    });

    test("after a key is saved and with connectivity results", async ({ page, request }) => {
      await setMockFaults(request, { service_test_fail: ["openai"] });
      await openEditableSettings(page);
      const jev = secretRow(page, "jev_api_key");
      await jev.getByRole("button", { name: "Set key Jev API key" }).click();
      await jev.getByLabel("New value for Jev API key").fill(TYPED_KEY);
      await jev.getByRole("button", { name: "Save key" }).click();
      await expect(jev.getByText(/saved\. It is stored write-only/)).toBeVisible();
      await page.getByRole("button", { name: "Test Laya connection" }).click();
      await page.getByRole("button", { name: "Test OpenAI connection" }).click();
      await page.getByRole("button", { name: "Test Jev connection" }).click();
      await expect(serviceRow(page, "laya")).toHaveAttribute("data-state", "ok");
      await expect(serviceRow(page, "openai")).toHaveAttribute("data-state", "failed");
      await expect(serviceRow(page, "jev")).toHaveAttribute("data-state", "failed");

      await expectNoAxeViolations(page);
    });

    test("while a connectivity test is running", async ({ page, request }) => {
      await setMockFaults(request, { health_slow: 4000 });
      await openEditableSettings(page);
      await page.getByRole("button", { name: "Test Laya connection" }).click();
      await expect(serviceRow(page, "laya")).toHaveAttribute("data-state", "running");

      await expectNoAxeViolations(page);
      await expect(serviceRow(page, "laya")).toHaveAttribute("data-state", "ok", {
        timeout: SETTLE_TIMEOUT_MS,
      });
    });

    test("with the leave warning open", async ({ page }) => {
      await openEditableSettings(page);
      await field(page, "Max concurrency").fill("8");
      await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: "Targets" })
        .click();
      await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toBeVisible();
      await settleAnimations(page);

      await expectNoAxeViolations(page);
    });

    test("in the settings error state", async ({ page }) => {
      await page.route("**/api/v1/settings", (route) =>
        route.request().method() === "GET"
          ? route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({
                error: {
                  code: "internal_error",
                  message: "Boom",
                  request_id: "req-axe",
                  details: [],
                },
              }),
            })
          : route.fallback(),
      );
      await page.goto("/settings");
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "Could not load the settings",
        { timeout: SETTLE_TIMEOUT_MS },
      );

      await expectNoAxeViolations(page);
    });
  });

  test.describe(`axe on the settings page as a viewer in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme, storageState: SIGNED_OUT_STORAGE_STATE });

    test("read-only", async ({ page, request }) => {
      await resetMockApi(request);
      await seedSettings(request, "overridden");
      await page.goto("/login");
      await signInThroughForm(page, VIEWER);
      await openSettings(page);
      await expect(page.getByText(/You have read-only access/)).toBeVisible();

      await expectNoAxeViolations(page);
    });
  });
}
