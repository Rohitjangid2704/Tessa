import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../helpers/axe";
import { apiOrigin } from "../helpers/env";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const PLUGIN_SOURCE = process.env.NEXT_PUBLIC_PLUGIN_SOURCE;
const INSTALL_COMMAND = "claude plugin install tessa@tessa";
const CONNECT_COMMAND = "/tessa:connect";
const colorSchemes = ["light", "dark"] as const;

const pageErrors: string[] = [];

test.beforeEach(async ({ page, request }) => {
  pageErrors.length = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await resetMockApi(request);
});

test.afterEach(async ({ request }) => {
  await clearMockFaults(request);
  expect(pageErrors).toEqual([]);
});

async function expectConnectSteps(page: Page) {
  const steps = page.getByRole("list", { name: "Connect steps" });
  await expect(steps.getByRole("listitem")).toHaveCount(3);
  await expect(steps).toContainText("claude plugin marketplace add ");
  if (PLUGIN_SOURCE !== undefined && PLUGIN_SOURCE !== "") {
    await expect(steps).toContainText(`claude plugin marketplace add ${PLUGIN_SOURCE}`);
  }
  await expect(steps).toContainText(INSTALL_COMMAND);
  await expect(steps).toContainText(CONNECT_COMMAND);
}

test.describe("Connect panel on /settings/tokens", () => {
  test("comes first when there is no token and shows the API URL and the notes", async ({
    page,
  }) => {
    await page.goto("/settings/tokens");
    const panel = page.locator("[data-slot=connect-panel]");
    await expect(panel).toBeVisible();
    await expectConnectSteps(page);
    await expect(panel).toContainText(apiOrigin());
    await expect(panel).toContainText("operating system credential store");
    await expect(panel).toContainText("On Windows");

    const emptyBox = await page.getByText("No tokens yet").boundingBox();
    const panelBox = await panel.boundingBox();
    expect(panelBox?.y).toBeLessThan(emptyBox?.y ?? 0);
  });

  test("moves under the token table once a token exists", async ({ page, request }) => {
    await request.post(`${apiOrigin()}/__mock/stage11/seed`, {
      data: { variants: { tokens: "expired" } },
    });
    await page.goto("/settings/tokens");
    const panel = page.locator("[data-slot=connect-panel]");
    const table = page.getByRole("table", { name: "Personal tokens" });
    await expect(table).toBeVisible();
    const tableBox = await table.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(panelBox?.y).toBeGreaterThan(tableBox?.y ?? 0);
  });

  test("copies each command", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(baseURL ?? "http://localhost:3000").origin,
    });
    await page.goto("/settings/tokens");
    const panel = page.locator("[data-slot=connect-panel]");

    await panel.getByRole("button", { name: /Copy\s*install command/ }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(INSTALL_COMMAND);

    await panel.getByRole("button", { name: /Copy\s*connect command/ }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CONNECT_COMMAND);

    await panel.getByRole("button", { name: /Copy\s*API URL/ }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(apiOrigin());
  });
});

test.describe("Connect panel in the new target wizard", () => {
  test("sits collapsed under Run it in Claude Code instead", async ({ page }) => {
    await page.goto("/targets/new");
    await page.getByLabel("Name").fill("Acme Shop");
    await page.getByRole("combobox", { name: "App kind" }).click();
    await page.getByRole("option", { name: "Web app" }).click();
    await page.getByRole("button", { name: "Create target" }).click();
    await expect(page.getByText("Target created")).toBeVisible();

    const trigger = page.getByRole("button", { name: "Run it in Claude Code instead" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-slot=connect-panel]")).toHaveCount(0);

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-slot=connect-panel]")).toBeVisible();
    await expectConnectSteps(page);
    await page.getByRole("link", { name: "create one in Settings" }).click();
    await expect(page).toHaveURL(/\/settings\/tokens$/);
  });
});

for (const scheme of colorSchemes) {
  test.describe(`axe on /settings/tokens in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("empty state with the Connect panel has no violations", async ({ page }) => {
      await page.goto("/settings/tokens");
      await expect(page.locator("[data-slot=connect-panel]")).toBeVisible();
      await expect(page.getByText("No tokens yet")).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("token table with every state has no violations", async ({ page, request }) => {
      await request.post(`${apiOrigin()}/__mock/stage11/seed`, {
        data: { variants: { tokens: "expired" } },
      });
      await page.goto("/settings/tokens");
      await expect(page.getByRole("row", { name: /lost phone/ })).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("create and shown-once dialogs have no violations", async ({ page }) => {
      await page.goto("/settings/tokens");
      await page.getByRole("button", { name: "New token" }).click();
      await expect(page.getByRole("dialog", { name: "New personal token" })).toBeVisible();
      await expectNoAxeViolations(page);

      await page.getByLabel("Name").fill("axe");
      await page.getByRole("button", { name: "Create token" }).click();
      await expect(page.getByRole("dialog", { name: "Token created" })).toBeVisible();
      await expectNoAxeViolations(page);
    });
  });
}
