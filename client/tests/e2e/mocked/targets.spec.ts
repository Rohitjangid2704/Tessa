import { expect, test, type Page } from "@playwright/test";
import { STAGE_ONE_IDS } from "../../../mocks/stage1/seed";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { expectNoAxeViolations } from "../helpers/axe";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";
import { signInThroughForm } from "../helpers/login";

const { gracie, billing, liveShop, legacyPortal } = STAGE_ONE_IDS;
const UNKNOWN_TARGET = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9999";
const CURRENT_TARGET_KEY = "tessa.current-target";
const TOKEN_PATTERN = /tgt_[A-Za-z0-9]{22}/;

const FAILED_RESOURCE_LOG = "Failed to load resource";
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

async function chooseAppKind(page: Page, label: string) {
  await page.getByRole("combobox", { name: "App kind" }).click();
  await page.getByRole("option", { name: label }).click();
}

async function createTarget(page: Page, name: string, appKind: string) {
  await page.goto("/targets/new");
  await page.getByLabel("Name").fill(name);
  await chooseAppKind(page, appKind);
  await page.getByRole("button", { name: "Create target" }).click();
  await expect(page.getByText("Target created")).toBeVisible();
}

async function targetRows(page: Page): Promise<string[]> {
  const table = page.getByRole("table", { name: "Targets" });
  await expect(page.getByText(/^Showing \d+ of \d+ targets?$/)).toBeVisible();
  return table.getByRole("row").evaluateAll((rows) =>
    rows
      .slice(1)
      .map((row) => row.querySelector("td a")?.textContent?.trim() ?? "")
      .filter((name) => name !== ""),
  );
}

test.describe("creating a target", () => {
  test("creates a target, copies the prompt and ticks the checklist", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(baseURL ?? "http://localhost:3000").origin,
    });

    await createTarget(page, "Acme Shop", "Web app");

    await expect(page.getByText("QA", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "Describe the key browser flows" }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Generate Discovery prompt" }).click();

    const prompt = page.getByRole("textbox", { name: "Discovery prompt" });
    await expect(prompt).toHaveValue(TOKEN_PATTERN);
    await expect(prompt).toHaveValue(/schemas\/bundle\.v1\.json/);
    await expect(page.locator("[data-slot=discovery-prompt-panel] dl")).toContainText(
      "Discovery v2",
    );
    const shown = await prompt.inputValue();

    await page.getByRole("button", { name: "Copy prompt" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.replace(/\r\n/g, "\n")).toBe(shown);

    await page.getByRole("checkbox", { name: "Open VS Code" }).check();
    await page.getByRole("checkbox", { name: "Paste the prompt and send it" }).check();
    await expect(page.getByText("2 of 7 steps done")).toBeVisible();
    await expect(
      page.getByRole("group", { name: "PowerShell command" }).getByText(/Compress-Archive/),
    ).toBeVisible();

    await page.getByRole("link", { name: "Open the target page" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Acme Shop" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Discovery prompt" })).toHaveValue(shown);
    await expect(page.getByText("2 of 7 steps done")).toBeVisible();

    await page.reload();
    await expect(page.getByText("2 of 7 steps done")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Open VS Code" })).toBeChecked();
  });

  test("falls back to the legacy copy when the clipboard API is denied", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
      });
    });
    await createTarget(page, "Acme Shop", "HTTP API");
    await page.getByRole("button", { name: "Generate Discovery prompt" }).click();
    await expect(page.getByRole("textbox", { name: "Discovery prompt" })).toHaveValue(
      TOKEN_PATTERN,
    );

    await page.getByRole("button", { name: "Copy prompt" }).click();

    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect(page.getByText(/blocked copying/)).toHaveCount(0);
  });

  test("validates the form and keeps the user on step 1", async ({ page }) => {
    await page.goto("/targets/new");
    await page.getByRole("button", { name: "Create target" }).click();

    await expect(page.getByText("Enter a name")).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Choose an app kind" })).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Target created")).toHaveCount(0);
  });

  test("shows a server 422 on the field it names", async ({ page }) => {
    await page.route("**/api/v1/targets", async (route) => {
      if (route.request().method() !== "POST") {
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
            request_id: "req-e2e-422",
            details: [{ loc: ["body", "name"], code: "x", message: "Name is already taken" }],
          },
        }),
      });
    });
    await page.goto("/targets/new");
    await page.getByLabel("Name").fill("Gracie");
    await chooseAppKind(page, "LLM assistant");

    await page.getByRole("button", { name: "Create target" }).click();

    await expect(page.getByText("Name is already taken")).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Target created")).toHaveCount(0);
  });

  test("a new target shows up in the list and becomes the current target", async ({ page }) => {
    await createTarget(page, "Acme Shop", "Web app");

    await page.goto("/targets");

    expect(await targetRows(page)).toContain("Acme Shop");
    await expect(page.getByRole("combobox", { name: "Current target" })).toContainText("Acme Shop");
  });
});

test.describe("targets list", () => {
  test("lists the active targets newest first with their columns", async ({ page }) => {
    await page.goto("/targets");

    expect(await targetRows(page)).toEqual(["Broken Import", "Live Shop", "Billing API", "Gracie"]);
    const table = page.getByRole("table", { name: "Targets" });
    await expect(
      table.getByRole("columnheader").evaluateAll((cells) => cells.map((cell) => cell.textContent)),
    ).resolves.toEqual([
      "Name",
      "App kind",
      "Tier",
      "Latest bundle",
      "Completeness",
      "Health",
      "Created",
    ]);
    const gracieRow = table.getByRole("row", { name: /^Gracie/ });
    await expect(gracieRow).toContainText("LLM assistant");
    await expect(gracieRow).toContainText("v2");
    await expect(gracieRow).toContainText("92 / 100");
    await expect(gracieRow).toContainText("Failed");
    await expect(table.getByRole("row", { name: /^Live Shop/ })).toContainText("Production");
  });

  test("filters by search, app kind, tier and archived and keeps them in the URL", async ({
    page,
  }) => {
    await page.goto("/targets");
    await targetRows(page);

    await page.getByRole("searchbox", { name: "Search" }).fill("grac");
    await expect(page).toHaveURL(/\?q=grac$/);
    expect(await targetRows(page)).toEqual(["Gracie"]);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/targets$/);
    expect(await targetRows(page)).toHaveLength(4);

    await page.getByRole("button", { name: /App kind/ }).click();
    await page.getByRole("checkbox", { name: "HTTP API" }).check();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/app_kind=api/);
    expect(await targetRows(page)).toEqual(["Billing API"]);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByRole("button", { name: /Tier/ }).click();
    await page.getByRole("checkbox", { name: "Production" }).check();
    await page.keyboard.press("Escape");
    expect(await targetRows(page)).toEqual(["Live Shop"]);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByRole("switch", { name: "Include archived" }).click();
    await expect(page).toHaveURL(/include_archived=true/);
    expect(await targetRows(page)).toContain("Legacy Portal");
    await expect(
      page.getByRole("table", { name: "Targets" }).getByRole("row", { name: /^Legacy Portal/ }),
    ).toContainText("Archived");
  });

  test("sorts by name from the header and restores the state from the URL", async ({ page }) => {
    await page.goto("/targets");
    await targetRows(page);

    await page.getByRole("button", { name: "Sort by Name" }).click();
    await expect(page).toHaveURL(/sort=name/);
    expect(await targetRows(page)).toEqual(["Billing API", "Broken Import", "Gracie", "Live Shop"]);

    await page.reload();
    expect(await targetRows(page)).toEqual(["Billing API", "Broken Import", "Gracie", "Live Shop"]);
    await expect(page.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );

    await page.goto("/targets?q=zzz");
    await expect(page.getByRole("heading", { name: "No targets match" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    expect(await targetRows(page)).toHaveLength(4);
  });

  test("opens a target from its name", async ({ page }) => {
    await page.goto("/targets");
    await targetRows(page);

    await page.getByRole("link", { name: "Gracie" }).click();

    await expect(page).toHaveURL(new RegExp(`/targets/${gracie}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Gracie" })).toBeVisible();
  });
});

test.describe("target detail", () => {
  test("shows the header, tabs, latest bundle and token", async ({ page }) => {
    await page.goto(`/targets/${gracie}`);

    await expect(page.getByRole("heading", { level: 1, name: "Gracie" })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "Target sections" });
    await expect(tabs.getByRole("link")).toHaveText([
      "Overview",
      "Bundles",
      "Environment",
      "Proposal",
    ]);
    await expect(tabs.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(tabs.getByRole("link", { name: "Bundles" })).toHaveAttribute(
      "href",
      `/targets/${gracie}/bundles`,
    );
    await expect(tabs.getByRole("link", { name: "Environment" })).toHaveAttribute(
      "href",
      `/targets/${gracie}/environment`,
    );
    await expect(tabs.getByRole("link", { name: "Proposal" })).toHaveAttribute(
      "href",
      `/targets/${gracie}/proposal`,
    );

    const latest = page.locator("[data-slot=latest-bundle-card]");
    await expect(latest).toContainText("Version 2");
    await expect(latest).toContainText("Valid");
    await expect(latest).toContainText("Meets bar");
    await expect(latest).toContainText("92 / 100");
    await expect(page.locator("[data-slot=token-card]")).toContainText("tgt_graciedemotokenaaaa");
  });

  test("moves between tabs and keeps the header", async ({ page }) => {
    await page.goto(`/targets/${gracie}`);
    await expect(page.getByRole("heading", { level: 1, name: "Gracie" })).toBeVisible();

    await page
      .getByRole("navigation", { name: "Target sections" })
      .getByRole("link", { name: "Bundles" })
      .click();

    await expect(page).toHaveURL(new RegExp(`/targets/${gracie}/bundles$`));
    await expect(page.getByRole("heading", { level: 1, name: "Gracie" })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Target sections" })
        .getByRole("link", { name: "Bundles" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("rotates the token only after confirmation", async ({ page }) => {
    await page.goto(`/targets/${gracie}`);
    const card = page.locator("[data-slot=token-card]");
    await expect(card).toContainText("tgt_graciedemotokenaaaa");

    await card.getByRole("button", { name: "Rotate token" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Rotate the token of Gracie?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(card).toContainText("tgt_graciedemotokenaaaa");

    await card.getByRole("button", { name: "Rotate token" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Rotate token" }).click();

    await expect(card).not.toContainText("tgt_graciedemotokenaaaa");
    await expect(card.locator("code")).toHaveText(TOKEN_PATTERN);
  });

  test("lists the prompt history and reopens a prompt in a dialog", async ({ page }) => {
    await page.goto(`/targets/${gracie}`);
    await page.getByRole("button", { name: "Generate Discovery prompt" }).click();
    const prompt = page.getByRole("textbox", { name: "Discovery prompt" });
    await expect(prompt).toHaveValue(TOKEN_PATTERN);
    const issued = await prompt.inputValue();

    const history = page.getByRole("table", { name: "Prompt history" });
    await expect(history.getByRole("row", { name: /Discovery v2/ })).toBeVisible();
    await history.getByRole("button", { name: "Open Discovery v2 prompt" }).click();

    const dialog = page.getByRole("dialog", { name: "Discovery prompt" });
    await expect(dialog.getByRole("textbox", { name: "Discovery prompt" })).toHaveValue(issued);
    await dialog.getByRole("button", { name: "View template v2" }).click();
    await expect(
      page.getByRole("dialog", { name: "Discovery template" }).getByRole("textbox", {
        name: "Template text",
      }),
    ).toHaveValue(/\{\{TARGET_TOKEN\}\}/);
  });

  test("renames the target", async ({ page }) => {
    await page.goto(`/targets/${billing}`);
    const settings = page.locator("[data-slot=target-settings-card]");
    const input = settings.getByLabel("Name", { exact: true });
    await expect(input).toHaveValue("Billing API");

    await input.fill("Billing API v2");
    await settings.getByRole("button", { name: "Save name" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Billing API v2" })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  test("archives a target after confirmation and hides it from the default list", async ({
    page,
  }) => {
    await page.goto(`/targets/${billing}`);
    await expect(page.getByRole("heading", { level: 1, name: "Billing API" })).toBeVisible();

    await page.getByRole("button", { name: "Archive target" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Archive Billing API?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(new RegExp(`/targets/${billing}$`));

    await page.getByRole("button", { name: "Archive target" }).click();
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Archive target" });
    await expect(confirm).toBeVisible();
    await confirm.focus();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/targets$/);
    expect(await targetRows(page)).not.toContain("Billing API");

    await page.goto(`/targets/${billing}`);
    await expect(page.locator("[data-slot=archived-banner]")).toContainText(
      "This target is archived",
    );
    await expect(page.getByRole("button", { name: "Generate Discovery prompt" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Rotate token" })).toBeDisabled();
    await expect(
      page.locator("[data-slot=target-settings-card]").getByLabel("Name", { exact: true }),
    ).toBeDisabled();
  });

  test("makes a production target loud and lets an admin allow production", async ({ page }) => {
    await page.goto(`/targets/${liveShop}`);

    await expect(page.locator("[data-slot=production-banner]")).toContainText(
      "blocked until an admin allows production",
    );
    await expect(page.locator("[data-slot=target-header]")).toContainText("Production");

    await page
      .getByRole("switch", { name: "Allow runs against this target while it is production" })
      .click();

    await expect(page.locator("[data-slot=production-banner]")).toContainText(
      "are allowed and stay read-only",
    );
  });

  test("shows not found for an unknown target and for an id that is not a UUID", async ({
    page,
  }) => {
    await page.goto(`/targets/${UNKNOWN_TARGET}`);
    await expect(page.getByRole("heading", { name: "Target not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to targets" })).toHaveAttribute(
      "href",
      "/targets",
    );

    await page.goto("/targets/not-a-uuid");
    await expect(page.getByRole("heading", { name: "Target not found" })).toBeVisible();
  });
});

test.describe("hydration", () => {
  const RELOADS = 12;
  const SETTLE_TIMEOUT_MS = 5_000;

  test("never leaves a control disabled or missing after a reload of the target page", async ({
    page,
  }) => {
    await page.goto(`/targets/${gracie}`);

    for (let attempt = 0; attempt < RELOADS; attempt += 1) {
      await page.reload();
      await expect(page.getByRole("button", { name: "Generate Discovery prompt" })).toBeEnabled({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(page.getByRole("button", { name: "Rotate token" })).toBeEnabled({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(page.getByRole("button", { name: "Archive target" })).toBeEnabled({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(
        page.locator("[data-slot=target-settings-card]").getByLabel("Name", { exact: true }),
      ).toBeEnabled({ timeout: SETTLE_TIMEOUT_MS });
    }
  });

  test("never leaves the list and the wizard stuck after a reload", async ({ page }) => {
    for (let attempt = 0; attempt < RELOADS; attempt += 1) {
      await page.goto("/targets");
      await expect(page.getByRole("link", { name: "New target" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(page.getByRole("link", { name: "Gracie" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await page.goto("/targets/new");
      await expect(page.getByRole("button", { name: "Create target" })).toBeEnabled({
        timeout: SETTLE_TIMEOUT_MS,
      });
    }
  });
});

test.describe("current target", () => {
  test("carries the visited target in the nav and across a reload", async ({ page }) => {
    await page.goto("/targets");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Catalog" })).toHaveAttribute("href", "/catalog");

    await page.goto(`/targets/${gracie}`);
    await expect(nav.getByRole("link", { name: "Catalog" })).toHaveAttribute(
      "href",
      `/catalog?target_id=${gracie}`,
    );
    await expect(nav.getByRole("link", { name: "Targets" })).toHaveAttribute("href", "/targets");
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");

    await page.goto("/settings");
    await expect(nav.getByRole("link", { name: "Runs" })).toHaveAttribute(
      "href",
      `/runs?target_id=${gracie}`,
    );
    expect(await page.evaluate((key) => window.localStorage.getItem(key), CURRENT_TARGET_KEY)).toBe(
      gracie,
    );
  });

  test("lets ?target_id= win over the last used target", async ({ page }) => {
    await page.goto(`/targets/${gracie}`);
    await expect(page.getByRole("heading", { level: 1, name: "Gracie" })).toBeVisible();

    await page.goto(`/runs?target_id=${billing}`);

    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Catalog" })).toHaveAttribute(
      "href",
      `/catalog?target_id=${billing}`,
    );
    await expect(page.getByRole("combobox", { name: "Current target" })).toContainText(
      "Billing API",
    );
  });

  test("switches target from the header and keeps the same tab", async ({ page }) => {
    await page.goto(`/targets/${gracie}/bundles`);
    const switcher = page.getByRole("combobox", { name: "Current target" });
    await expect(switcher).toContainText("Gracie");

    await switcher.click();
    await page.getByRole("option", { name: "Billing API" }).click();

    await expect(page).toHaveURL(new RegExp(`/targets/${billing}/bundles$`));
    await expect(switcher).toContainText("Billing API");
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Catalog" }),
    ).toHaveAttribute("href", `/catalog?target_id=${billing}`);
  });

  test("marks a production target in the header switcher", async ({ page }) => {
    await page.goto(`/targets/${liveShop}`);

    await expect(page.locator("[data-slot=target-switcher]")).toContainText("Production");
  });

  test("shows a placeholder in the switcher when no target is known", async ({ page }) => {
    await page.goto("/targets");
    await expect(page.getByRole("combobox", { name: "Current target" })).toContainText(
      "Select a target",
    );
  });
});

test.describe("viewer role", () => {
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

  test("is read-only: no New target, no wizard, nothing to change on a target", async ({
    page,
  }) => {
    await page.goto("/login");
    await signInThroughForm(page, {
      email: "viewer@tessa.local",
      password: "dev-only-viewer-password-1",
    });

    await page.goto("/targets");
    await expect(page.getByRole("heading", { level: 1, name: "Targets" })).toBeVisible();
    expect((await targetRows(page)).length).toBeGreaterThan(0);
    await expect(page.getByRole("link", { name: "New target" })).toHaveCount(0);

    await page.goto("/targets/new");
    await expect(page.getByText("You cannot create targets")).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveCount(0);

    await page.goto(`/targets/${gracie}`);
    await expect(page.getByRole("heading", { level: 1, name: "Gracie" })).toBeVisible();
    await expect(page.getByText(/issuing one needs the member or admin role/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate Discovery prompt" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Rotate token" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive target" })).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy target token" }).first()).toBeVisible();
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
  test.describe(`axe on the target routes in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("/targets", async ({ page }) => {
      await page.goto("/targets");
      await targetRows(page);
      await expectTheme(page, scheme);

      await expectNoAxeViolations(page);
    });

    test("/targets with filters and no match", async ({ page }) => {
      await page.goto("/targets?q=zzz&include_archived=true");
      await expect(page.getByRole("heading", { name: "No targets match" })).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("/targets/new, step 1 and a validation error", async ({ page }) => {
      await page.goto("/targets/new");
      await expect(page.getByLabel("Name")).toBeVisible();
      await expectTheme(page, scheme);
      await expectNoAxeViolations(page);

      await page.getByRole("button", { name: "Create target" }).click();
      await expect(page.getByText("Enter a name")).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("/targets/new, step 2 with a generated prompt", async ({ page }) => {
      await createTarget(page, "Acme Shop", "LLM assistant");
      await page.getByRole("button", { name: "Generate Discovery prompt" }).click();
      await expect(page.getByRole("textbox", { name: "Discovery prompt" })).toHaveValue(
        TOKEN_PATTERN,
      );
      await page.getByRole("checkbox", { name: "Open VS Code" }).check();

      await expectNoAxeViolations(page);
    });

    test("/targets/[targetId]", async ({ page }) => {
      await page.goto(`/targets/${gracie}`);
      await expect(page.locator("[data-slot=latest-bundle-card]")).toContainText("Version 2");
      await expect(page.getByRole("checkbox", { name: /tools/ })).toBeVisible();
      await expectTheme(page, scheme);

      await expectNoAxeViolations(page);
    });

    test("/targets/[targetId] with prompt history and dialogs", async ({ page }) => {
      await page.goto(`/targets/${gracie}`);
      await page.getByRole("button", { name: "Generate Discovery prompt" }).click();
      const history = page.getByRole("table", { name: "Prompt history" });
      await expect(history.getByRole("row", { name: /Discovery v2/ })).toBeVisible();
      await expectNoAxeViolations(page);

      await history.getByRole("button", { name: "Open Discovery v2 prompt" }).click();
      const dialog = page.getByRole("dialog", { name: "Discovery prompt" });
      await expect(dialog.getByRole("textbox", { name: "Discovery prompt" })).toHaveValue(
        TOKEN_PATTERN,
      );
      await expectNoAxeViolations(page);
    });

    test("/targets/[targetId] rotate confirmation", async ({ page }) => {
      await page.goto(`/targets/${gracie}`);
      await page.getByRole("button", { name: "Rotate token" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("/targets/[targetId] for a production target", async ({ page }) => {
      await page.goto(`/targets/${liveShop}`);
      await expect(page.locator("[data-slot=production-banner]")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("/targets/[targetId] for an archived target", async ({ page }) => {
      await page.goto(`/targets/${legacyPortal}`);
      await expect(page.locator("[data-slot=archived-banner]")).toContainText(
        "This target is archived",
      );

      await expectNoAxeViolations(page);
    });

    test("/targets/[targetId] for an unknown target", async ({ page }) => {
      await page.goto(`/targets/${UNKNOWN_TARGET}`);
      await expect(page.getByRole("heading", { name: "Target not found" })).toBeVisible();

      await expectNoAxeViolations(page);
    });
  });
}
