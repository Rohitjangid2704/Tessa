import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { STAGE_ONE_IDS } from "../../../mocks/stage1/seed";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { expectNoAxeViolations } from "../helpers/axe";
import { signInThroughForm } from "../helpers/login";
import { clearMockFaults, resetMockApi, setMockFaults } from "../helpers/mock-api";

const { gracie, billing, legacyPortal } = STAGE_ONE_IDS;
const SETTLE_TIMEOUT_MS = 15_000;
const RELOADS = 12;
const FAILED_RESOURCE_LOG = "Failed to load resource";
const SECRET_PASSWORD = "dev-only-e2e-secret-4f9a1c";
const SECRET_DSN = `postgresql://qa_reader:${SECRET_PASSWORD}@db.qa.example.test:5432/gracie`;
const SECRET_TOKEN = "dev-only-e2e-token-7b3d90";

let pageErrors: string[] = [];

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

function environmentUrl(targetId: string): string {
  return `/targets/${targetId}/environment`;
}

async function openEnvironment(page: Page, targetId: string = gracie): Promise<void> {
  await recordPatches(page);
  await page.goto(environmentUrl(targetId));
  await expect(page.getByRole("heading", { level: 2, name: "Variables", exact: true })).toBeVisible(
    {
      timeout: SETTLE_TIMEOUT_MS,
    },
  );
  await expect(
    page.getByRole("heading", { level: 2, name: "Health checks", exact: true }),
  ).toBeVisible();
}

async function openFilledEnvironment(page: Page, targetId: string = gracie): Promise<void> {
  await openEnvironment(page, targetId);
  await expect(page.getByRole("form", { name: "Environment variables" })).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
  await expect(page.getByRole("list", { name: "Interface health" })).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
}

function variable(page: Page, name: string): Locator {
  return page.locator(`[data-variable="${name}"]`);
}

function input(page: Page, name: string): Locator {
  return variable(page, name).getByLabel(name, { exact: true });
}

function saveButton(page: Page): Locator {
  return page.getByRole("button", { name: "Save changes" });
}

function runButton(page: Page): Locator {
  return page.getByRole("button", { name: "Run health checks", exact: true });
}

function healthRow(page: Page, interfaceId: string): Locator {
  return page.locator(`[data-slot=health-row][data-interface="${interfaceId}"]`);
}

interface RecordedWindow {
  __environmentPatches: string[];
}

async function recordPatches(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const patches: string[] = [];
    Object.defineProperty(window, "__environmentPatches", { value: patches });
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (
        input instanceof Request &&
        input.method === "PATCH" &&
        input.url.endsWith("/environment")
      ) {
        patches.push(await input.clone().text());
      }
      return original(input, init);
    };
  });
}

async function sentPatches(page: Page): Promise<string[]> {
  await page.waitForFunction(
    () => (window as unknown as RecordedWindow).__environmentPatches.length > 0,
  );
  return page.evaluate(() => [...(window as unknown as RecordedWindow).__environmentPatches]);
}

async function sentPatch(page: Page): Promise<{ set: Record<string, string>; clear: string[] }> {
  const [first] = await sentPatches(page);
  return JSON.parse(first ?? "null") as { set: Record<string, string>; clear: string[] };
}

function isEnvironmentPatch(request: Request): boolean {
  return request.method() === "PATCH" && request.url().endsWith("/environment");
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

test.describe("environment page", () => {
  test("shows the variables with their state and the missing-required banner", async ({ page }) => {
    await openFilledEnvironment(page);

    await expect(page.getByRole("heading", { level: 1, name: "Gracie" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Target sections" }).getByRole("link", {
        name: "Environment",
      }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.locator("[data-slot=env-variable-field]")).toHaveCount(12);
    const banner = page.locator("[data-slot=missing-required-banner]");
    await expect(banner).toContainText("1 required variable has no value");
    await expect(banner).toContainText("GRACIE_READONLY_DSN");
    await expect(input(page, "GRACIE_API_URL")).toHaveValue("https://gracie-api.qa.example.test");
    await expect(input(page, "GRACIE_ADMIN_TOKEN")).toHaveAttribute("type", "password");
    await expect(input(page, "GRACIE_ADMIN_TOKEN")).toHaveValue("");
    await expect(
      variable(page, "GRACIE_ADMIN_TOKEN").getByText("Set", { exact: true }),
    ).toBeVisible();
    await expect(
      variable(page, "GRACIE_READONLY_DSN").getByText("Not set", { exact: true }),
    ).toBeVisible();
    const stale = page.getByRole("region", { name: "Not used by the latest bundle" });
    await expect(stale.getByText("Stale")).toHaveCount(2);
  });

  test("opens from the Environment tab of a target", async ({ page }) => {
    await page.goto(`/targets/${gracie}`);

    await page
      .getByRole("navigation", { name: "Target sections" })
      .getByRole("link", { name: "Environment" })
      .click();

    await expect(page).toHaveURL(new RegExp(`/targets/${gracie}/environment$`));
    await expect(page.getByRole("form", { name: "Environment variables" })).toBeVisible();
  });

  test("saves a secret, sends only the dirty variable and clears the field", async ({ page }) => {
    await openFilledEnvironment(page);
    await input(page, "GRACIE_READONLY_DSN").fill(SECRET_DSN);

    await saveButton(page).click();

    expect(await sentPatch(page)).toEqual({
      set: { GRACIE_READONLY_DSN: SECRET_DSN },
      clear: [],
    });
    await expect(page.getByText("Saved: 1 value set.")).toBeVisible();
    await expect(page.locator("[data-slot=missing-required-banner]")).toHaveCount(0);
    await expect(
      variable(page, "GRACIE_READONLY_DSN").getByText("Set", { exact: true }),
    ).toBeVisible();
    await expect(input(page, "GRACIE_READONLY_DSN")).toHaveValue("");
    await expect(saveButton(page)).toBeDisabled();
  });

  test("saves with Enter from the keyboard", async ({ page }) => {
    await openFilledEnvironment(page);
    await input(page, "GRACIE_READONLY_DSN").fill(SECRET_DSN);

    await input(page, "GRACIE_READONLY_DSN").press("Enter");

    await expect(page.getByText("Saved: 1 value set.")).toBeVisible();
  });

  test("sends bool and number values as strings and a cleared secret in clear", async ({
    page,
  }) => {
    await openFilledEnvironment(page);
    await variable(page, "GRACIE_STRICT_CONFIRMATION").getByRole("switch").click();
    await input(page, "GRACIE_CHAT_TIMEOUT_SECONDS").fill("45");
    await variable(page, "GRACIE_GUEST_PASSWORD")
      .getByRole("button", { name: "Clear stored value of GRACIE_GUEST_PASSWORD" })
      .click();

    await saveButton(page).click();

    expect(await sentPatch(page)).toEqual({
      set: { GRACIE_STRICT_CONFIRMATION: "true", GRACIE_CHAT_TIMEOUT_SECONDS: "45" },
      clear: ["GRACIE_GUEST_PASSWORD"],
    });
    await expect(page.getByText("Saved: 2 values set, 1 value cleared.")).toBeVisible();
    await expect(input(page, "GRACIE_CHAT_TIMEOUT_SECONDS")).toHaveValue("45");
    await expect(variable(page, "GRACIE_STRICT_CONFIRMATION").getByRole("switch")).toBeChecked();
    await expect(
      variable(page, "GRACIE_GUEST_PASSWORD").getByText("Not set", { exact: true }),
    ).toBeVisible();
  });

  test("an untouched secret is never sent when other fields change", async ({ page }) => {
    await openFilledEnvironment(page);
    await input(page, "GRACIE_GUEST_EMAIL").fill("someone.else@example.test");

    await saveButton(page).click();

    const body = await sentPatch(page);
    expect(body.set).toEqual({ GRACIE_GUEST_EMAIL: "someone.else@example.test" });
    expect(Object.keys(body.set)).not.toContain("GRACIE_ADMIN_TOKEN");
    expect(Object.keys(body.set)).not.toContain("GRACIE_GUEST_PASSWORD");
  });

  test("validates a URL, a number and a DSN before saving", async ({ page }) => {
    await openFilledEnvironment(page);
    let patched = false;
    page.on("request", (request) => {
      patched ||= isEnvironmentPatch(request);
    });
    await input(page, "GRACIE_API_URL").fill("not a url");
    await input(page, "GRACIE_CHAT_TIMEOUT_SECONDS").fill("soon");
    await input(page, "GRACIE_READONLY_DSN").fill("reader@db");

    await saveButton(page).click();

    await expect(page.getByText("Enter a URL like scheme://host")).toBeVisible();
    await expect(page.getByText("Enter a finite number like 30 or 0.5")).toBeVisible();
    await expect(page.getByText("Enter a DSN like scheme://host")).toBeVisible();
    await expect(input(page, "GRACIE_API_URL")).toHaveAttribute("aria-invalid", "true");
    expect(patched).toBe(false);
  });

  test("shows a server validation error on the variable and keeps what was typed", async ({
    page,
  }) => {
    await page.route("**/api/v1/targets/*/environment", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "validation_failed",
            message: "Request validation failed",
            request_id: "req-e2e-env-422",
            details: [
              {
                loc: ["body", "set", "GRACIE_READONLY_DSN"],
                code: "invalid_value",
                message: "A dsn variable needs a value like scheme://host",
              },
            ],
          },
        }),
      });
    });
    await openFilledEnvironment(page);
    await input(page, "GRACIE_READONLY_DSN").fill(SECRET_DSN);

    await saveButton(page).click();

    await expect(
      variable(page, "GRACIE_READONLY_DSN").getByText(
        "A dsn variable needs a value like scheme://host",
      ),
    ).toBeVisible();
    await expect(input(page, "GRACIE_READONLY_DSN")).toHaveValue(SECRET_DSN);
  });

  test("discards edits and clears Keep value", async ({ page }) => {
    await openFilledEnvironment(page);
    await input(page, "GRACIE_GUEST_EMAIL").fill("x@example.test");
    await variable(page, "GRACIE_ADMIN_TOKEN")
      .getByRole("button", { name: "Clear stored value of GRACIE_ADMIN_TOKEN" })
      .click();
    await expect(page.getByText("2 unsaved changes")).toBeVisible();

    await page.getByRole("button", { name: "Discard changes" }).click();

    await expect(input(page, "GRACIE_GUEST_EMAIL")).toHaveValue("guest.qa@example.test");
    await expect(input(page, "GRACIE_ADMIN_TOKEN")).toBeEnabled();
    await expect(saveButton(page)).toBeDisabled();
  });
});

test.describe("secrets never come back", () => {
  test("a typed secret appears in no response body and no DOM text after saving", async ({
    page,
  }) => {
    const bodies = collectResponseBodies(page);
    await openFilledEnvironment(page);
    await input(page, "GRACIE_READONLY_DSN").fill(SECRET_DSN);
    await input(page, "GRACIE_ADMIN_TOKEN").fill(SECRET_TOKEN);

    await saveButton(page).click();

    const [sent = ""] = await sentPatches(page);
    expect(sent).toContain(SECRET_PASSWORD);
    expect(sent).toContain(SECRET_TOKEN);
    await expect(page.getByText("Saved: 2 values set.")).toBeVisible();
    await runButton(page).click();
    await expect(healthRow(page, "truth:gracie_db")).toHaveAttribute("data-status", "ok");
    await page.reload();
    await expect(page.getByRole("form", { name: "Environment variables" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Interface health" })).toBeVisible();

    const responses = await bodies();
    expect(responses.length).toBeGreaterThan(5);
    for (const secret of [SECRET_PASSWORD, SECRET_TOKEN, SECRET_DSN]) {
      expect(responses.filter((text) => text.includes(secret))).toEqual([]);
    }
    for (const secret of [SECRET_PASSWORD, SECRET_TOKEN, SECRET_DSN]) {
      await expect(page.locator("body")).not.toContainText(secret);
      expect((await page.content()).includes(secret)).toBe(false);
      expect((await inputValues(page)).filter((value) => value.includes(secret))).toEqual([]);
      expect((await storageText(page)).includes(secret)).toBe(false);
    }
  });

  test("the DOM holds no secret right after the save either", async ({ page }) => {
    await openFilledEnvironment(page);
    await input(page, "GRACIE_READONLY_DSN").fill(SECRET_DSN);

    await saveButton(page).click();

    await expect(page.getByText("Saved: 1 value set.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(SECRET_PASSWORD);
    expect((await page.content()).includes(SECRET_PASSWORD)).toBe(false);
    expect((await inputValues(page)).filter((value) => value.includes(SECRET_PASSWORD))).toEqual(
      [],
    );
  });

  test("keeps every secret input a password field that never autofills", async ({ page }) => {
    await openFilledEnvironment(page);

    for (const name of ["GRACIE_ADMIN_TOKEN", "GRACIE_GUEST_PASSWORD", "GRACIE_READONLY_DSN"]) {
      await expect(input(page, name)).toHaveAttribute("type", "password");
      await expect(input(page, name)).toHaveAttribute("autocomplete", "off");
      await expect(input(page, name)).toHaveValue("");
    }
  });
});

test.describe("health checks", () => {
  test("shows the stored result with an ok, a failed and a skipped tick", async ({ page }) => {
    await openFilledEnvironment(page);

    await expect(healthRow(page, "rest_api")).toHaveAttribute("data-status", "ok");
    await expect(healthRow(page, "events_sse")).toHaveAttribute("data-status", "failed");
    await expect(healthRow(page, "events_sse")).toContainText(
      "Connection refused or host unreachable",
    );
    await expect(healthRow(page, "ops_webhook")).toHaveAttribute("data-status", "skipped");
    await expect(healthRow(page, "ops_webhook")).toContainText("is not checked yet");
    await expect(page.locator("[data-slot=health-strip]")).toContainText("Last checked");
  });

  test("runs the checks with progress and then replaces the strip", async ({ page, request }) => {
    await setMockFaults(request, { health_slow: 1500 });
    await openFilledEnvironment(page);
    await input(page, "GRACIE_READONLY_DSN").fill(SECRET_DSN);
    await saveButton(page).click();
    await expect(page.getByText("Saved: 1 value set.")).toBeVisible();

    await runButton(page).click();

    await expect(page.getByRole("progressbar", { name: "Running health checks" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Running health checks" })).toBeDisabled();
    await expect(page.locator("[data-slot=health-strip]")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("progressbar")).toHaveCount(0, { timeout: SETTLE_TIMEOUT_MS });
    await expect(healthRow(page, "truth:gracie_db")).toHaveAttribute("data-status", "ok");
    await expect(healthRow(page, "events_sse")).toHaveAttribute("data-status", "failed");
    await expect(healthRow(page, "ops_webhook")).toHaveAttribute("data-status", "skipped");
    await expect(
      variable(page, "GRACIE_EVENTS_URL").getByText("Failed", { exact: true }),
    ).toBeVisible();
    await expect(variable(page, "GRACIE_API_URL").getByText("OK", { exact: true })).toBeVisible();
    await expect(runButton(page)).toBeEnabled();
  });

  test("shows a skipped tick with its reason for a variable without a value", async ({ page }) => {
    await openFilledEnvironment(page);

    await runButton(page).click();

    await expect(healthRow(page, "truth:gracie_db")).toContainText(
      "No value set for GRACIE_READONLY_DSN",
    );
    await expect(healthRow(page, "truth:gracie_db")).toHaveAttribute("data-status", "skipped");
  });

  test("reports a timeout and keeps the last stored result", async ({ page }) => {
    await page.addInitScript(() => {
      AbortSignal.timeout = () => AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    });
    await openFilledEnvironment(page);

    await runButton(page).click();

    await expect(page.getByText("Health checks timed out")).toBeVisible();
    await expect(healthRow(page, "events_sse")).toBeVisible();
    await expect(runButton(page)).toBeEnabled();
  });

  test("sends a target without a valid bundle to the intake page", async ({ page }) => {
    await openEnvironment(page, billing);
    await expect(page.getByRole("heading", { name: "No variables yet" })).toBeVisible();
    await expect(page.getByText("No health check has run yet.")).toBeVisible();

    await runButton(page).click();

    const failure = page.locator("[data-slot=health-failure]");
    await expect(failure).toContainText("No valid bundle yet");
    await failure.getByRole("link", { name: "Upload a bundle" }).click();
    await expect(page).toHaveURL(new RegExp(`/targets/${billing}/bundles$`));
  });
});

test.describe("read-only access", () => {
  test("an archived target cannot be changed or checked", async ({ page }) => {
    await openEnvironment(page, legacyPortal);

    await expect(page.locator("[data-slot=archived-banner]")).toBeVisible();
    await expect(page.getByRole("heading", { name: "No variables yet" })).toBeVisible();
    await expect(runButton(page)).toBeDisabled();
    await expect(page.getByText(/archived, so health checks cannot run/)).toBeVisible();
  });

  test.describe("as a viewer", () => {
    test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

    test("sees values and health but cannot change or run anything", async ({ page }) => {
      await page.goto("/login");
      await signInThroughForm(page, {
        email: "viewer@tessa.local",
        password: "dev-only-viewer-password-1",
      });

      await openFilledEnvironment(page);

      await expect(page.getByText(/You have read-only access/)).toBeVisible();
      await expect(saveButton(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Clear stored value/ })).toHaveCount(0);
      await expect(input(page, "GRACIE_API_URL")).toHaveAttribute("readonly", "");
      await expect(input(page, "GRACIE_API_URL")).toHaveValue("https://gracie-api.qa.example.test");
      await expect(runButton(page)).toBeDisabled();
      await expect(healthRow(page, "events_sse")).toHaveAttribute("data-status", "failed");
    });
  });
});

test.describe("hydration", () => {
  test("never leaves the form or the health button stuck after a reload", async ({ page }) => {
    for (let attempt = 0; attempt < RELOADS; attempt += 1) {
      await page.goto(environmentUrl(gracie));
      await expect(input(page, "GRACIE_GUEST_EMAIL")).toBeEnabled({ timeout: SETTLE_TIMEOUT_MS });
      await expect(runButton(page)).toBeEnabled({ timeout: SETTLE_TIMEOUT_MS });
      await expect(page.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    }
  });
});

const colorSchemes = ["light", "dark"] as const;

async function expectTheme(page: Page, scheme: (typeof colorSchemes)[number]) {
  const html = page.locator("html");
  if (scheme === "dark") {
    await expect(html).toHaveClass(/\bdark\b/);
  } else {
    await expect(html).not.toHaveClass(/\bdark\b/);
  }
}

for (const scheme of colorSchemes) {
  test.describe(`axe on the environment page in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("loaded, with the banner, the stale group and the stored health", async ({ page }) => {
      await openFilledEnvironment(page);
      await expectTheme(page, scheme);

      await expectNoAxeViolations(page);
    });

    test("with edits, a cleared secret and validation errors", async ({ page }) => {
      await openFilledEnvironment(page);
      await input(page, "GRACIE_API_URL").fill("not a url");
      await input(page, "GRACIE_READONLY_DSN").fill("reader@db");
      await variable(page, "GRACIE_ADMIN_TOKEN")
        .getByRole("button", { name: "Clear stored value of GRACIE_ADMIN_TOKEN" })
        .click();
      await saveButton(page).click();
      await expect(page.getByText("Enter a URL like scheme://host")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("after a save and a health run", async ({ page }) => {
      await openFilledEnvironment(page);
      await input(page, "GRACIE_READONLY_DSN").fill(SECRET_DSN);
      await saveButton(page).click();
      await expect(page.getByText("Saved: 1 value set.")).toBeVisible();
      await runButton(page).click();
      await expect(healthRow(page, "truth:gracie_db")).toHaveAttribute("data-status", "ok");

      await expectNoAxeViolations(page);
    });

    test("while the health checks are running", async ({ page, request }) => {
      await setMockFaults(request, { health_slow: 4000 });
      await openFilledEnvironment(page);
      await runButton(page).click();
      await expect(page.getByRole("progressbar", { name: "Running health checks" })).toBeVisible();

      await expectNoAxeViolations(page);
      await expect(page.getByRole("progressbar")).toHaveCount(0, { timeout: SETTLE_TIMEOUT_MS });
    });

    test("with a health timeout error", async ({ page }) => {
      await page.addInitScript(() => {
        AbortSignal.timeout = () => AbortSignal.abort(new DOMException("t", "TimeoutError"));
      });
      await openFilledEnvironment(page);
      await runButton(page).click();
      await expect(page.getByText("Health checks timed out")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("for a target without variables", async ({ page }) => {
      await openEnvironment(page, billing);
      await expect(page.getByRole("heading", { name: "No variables yet" })).toBeVisible();
      await runButton(page).click();
      await expect(page.locator("[data-slot=health-failure]")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("for an archived target", async ({ page }) => {
      await openEnvironment(page, legacyPortal);
      await expect(page.locator("[data-slot=archived-banner]")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("in the environment error state", async ({ page }) => {
      await page.route("**/api/v1/targets/*/environment", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "internal_error", message: "Boom", request_id: "req-axe", details: [] },
          }),
        }),
      );
      await page.goto(environmentUrl(gracie));
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "Could not load the environment",
        {
          timeout: SETTLE_TIMEOUT_MS,
        },
      );

      await expectNoAxeViolations(page);
    });

    test("in the save error state", async ({ page }) => {
      await page.route("**/api/v1/targets/*/environment", async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "role_required", message: "No", request_id: "req-axe", details: [] },
          }),
        });
      });
      await openFilledEnvironment(page);
      await input(page, "GRACIE_GUEST_EMAIL").fill("x@example.test");
      await saveButton(page).click();
      await expect(page.getByText("Could not save the environment")).toBeVisible();

      await expectNoAxeViolations(page);
    });
  });

  test.describe(`axe on the environment page as a viewer in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme, storageState: SIGNED_OUT_STORAGE_STATE });

    test("read-only", async ({ page }) => {
      await page.goto("/login");
      await signInThroughForm(page, {
        email: "viewer@tessa.local",
        password: "dev-only-viewer-password-1",
      });
      await openFilledEnvironment(page);
      await expect(page.getByText(/You have read-only access/)).toBeVisible();

      await expectNoAxeViolations(page);
    });
  });
}
