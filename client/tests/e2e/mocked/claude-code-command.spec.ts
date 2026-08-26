import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { STAGE_ONE_IDS } from "../../../mocks/stage1/seed";
import { findingIdOf } from "../../../mocks/stage5/findings-seed";
import { apiOrigin } from "../helpers/env";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const GRACIE = STAGE_ONE_IDS.gracie;
const TOKEN_ARGUMENT = /^\/tessa:discover tgt_[A-Za-z0-9]{22}$/;
const FINDING_ID = findingIdOf(0);
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

test.beforeEach(async ({ context, request }) => {
  await resetMockApi(request);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test.afterEach(async ({ request }) => {
  await clearMockFaults(request);
});

async function seedProposals(request: APIRequestContext, variant: string): Promise<void> {
  const response = await request.post(`${apiOrigin()}/__mock/stage11/seed`, {
    data: { variants: { proposals: variant } },
  });
  expect(response.ok()).toBe(true);
}

async function expectCopyableChip(
  page: Page,
  scope: Locator,
  command: string | RegExp,
): Promise<void> {
  const chip = scope.getByRole("group", { name: "Claude Code command" });
  await expect(chip).toBeVisible();
  const code = chip.locator("code");
  await expect(code).toHaveText(command);
  const shown = (await code.textContent()) ?? "";
  await chip.focus();
  await expect(page.getByRole("tooltip")).toContainText("runs the same prompt through the plugin");
  await chip.getByRole("button", { name: "Copy Claude Code command" }).click();
  await expect(chip.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(shown);
}

test.describe("Claude Code command chip", () => {
  test("sits beside the copy button of the Discovery prompt", async ({ page }) => {
    await page.goto(`/targets/${GRACIE}`);
    await page.getByRole("button", { name: "Generate Discovery prompt" }).click();

    const panel = page.locator("[data-slot=discovery-prompt-panel]");
    await expect(panel.getByRole("textbox", { name: "Discovery prompt" })).toHaveValue(/tgt_/);
    await expectCopyableChip(page, panel, TOKEN_ARGUMENT);
    await expect(panel.getByRole("button", { name: "Copy prompt" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "run it in Claude Code" })).toHaveAttribute(
      "href",
      "/settings/tokens",
    );
  });

  test("sits beside the copy button of the Fix-up prompt", async ({ page }) => {
    await page.goto(`/targets/${GRACIE}/bundles`);
    await page.getByRole("link", { name: "Version 1", exact: true }).click();
    await page.getByRole("button", { name: "Generate Fix-up prompt" }).click();

    const dialog = page.getByRole("dialog", { name: "Fix-up prompt for version 1" });
    await expect(dialog.getByRole("textbox", { name: "Fix-up prompt text" })).toBeVisible();
    await expectCopyableChip(page, dialog, TOKEN_ARGUMENT);
    await expect(dialog.getByRole("button", { name: "Copy Fix-up prompt" })).toBeVisible();
  });

  test("sits beside the copy button of the Explain prompt", async ({ page }) => {
    await page.goto(`/findings/${FINDING_ID}`);
    await page.getByRole("button", { name: "Copy Explain prompt" }).click();

    const dialog = page.getByRole("dialog", { name: "Explain prompt" });
    await expect(dialog.getByText(/Explain v\d+/)).toBeVisible();
    await expectCopyableChip(page, dialog, `/tessa:explain ${FINDING_ID}`);
    await expect(dialog.getByRole("button", { name: "Copy Explain prompt" })).toBeVisible();
  });

  test("sits beside the copy button of the Author prompt with the selected cell ids", async ({
    page,
    request,
  }) => {
    await seedProposals(request, "empty");
    await page.goto(`/coverage?target_id=${GRACIE}`);
    await page.getByRole("switch", { name: "Select cells" }).click();
    const cell = page.locator("button[data-cell-id][data-status='empty']").first();
    const cellId = await cell.getAttribute("data-cell-id");
    await cell.click();
    await page.getByRole("button", { name: "Copy Author prompt (1)" }).click();

    const dialog = page.getByRole("dialog", { name: /Author prompt for 1 cell/ });
    await expect(dialog.getByRole("textbox", { name: "Author prompt text" })).toBeVisible();
    expect(cellId).toMatch(new RegExp(`^${UUID_PATTERN}$`));
    await expectCopyableChip(page, dialog, `/tessa:author ${cellId}`);
    await expect(dialog.getByRole("button", { name: "Copy Author prompt" })).toBeVisible();
  });

  test("carries the proposal item ids instead of the cell ids when the cell maps to items", async ({
    page,
  }) => {
    await page.goto(`/coverage?target_id=${GRACIE}`);
    await page.getByRole("switch", { name: "Select cells" }).click();
    const cell = page
      .locator("button[data-cell-id][data-status='empty']:has([data-slot=proposed-mark])")
      .first();
    const cellId = await cell.getAttribute("data-cell-id");
    await cell.click();
    await page.getByRole("button", { name: "Copy Author prompt (1)" }).click();

    const dialog = page.getByRole("dialog", { name: /Author prompt for 1 cell/ });
    await expect(dialog.getByRole("textbox", { name: "Author prompt text" })).toBeVisible();
    await expectCopyableChip(
      page,
      dialog,
      new RegExp(`^/tessa:author ${UUID_PATTERN}(,${UUID_PATTERN})*$`),
    );
    expect((await dialog.locator("code").first().textContent()) ?? "").not.toContain(cellId ?? "");
  });

  test("sits beside the copy button of the Mutants prompt", async ({ page }) => {
    await page.goto(`/mutation?target_id=${GRACIE}`);
    await page.getByRole("button", { name: "Generate Mutants prompt" }).click();

    const result = page.locator("[data-slot=mutants-prompt-card] [data-slot=prompt-result]");
    await expect(result.getByRole("textbox", { name: "Mutants prompt" })).toBeVisible();
    await expectCopyableChip(page, result, "/tessa:mutants");
    await expect(result.getByRole("button", { name: "Copy Mutants prompt" })).toBeVisible();
  });

  test("sits beside the copy button of the Hooks prompt", async ({ page }) => {
    await page.goto(`/mutation?target_id=${GRACIE}`);
    await page.getByRole("button", { name: "Generate Hooks prompt" }).click();

    const result = page.locator("[data-slot=hooks-prompt-card] [data-slot=prompt-result]");
    await expect(result.getByRole("textbox", { name: "Hooks prompt" })).toBeVisible();
    await expectCopyableChip(page, result, "/tessa:hooks");
    await expect(result.getByRole("button", { name: "Copy Hooks prompt" })).toBeVisible();
  });
});
