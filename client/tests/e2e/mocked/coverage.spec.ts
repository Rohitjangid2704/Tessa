import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STAGE_ONE_IDS } from "../../../mocks/stage1/seed";
import { expectNoAxeViolations } from "../helpers/axe";
import { apiOrigin } from "../helpers/env";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const { gracie } = STAGE_ONE_IDS;
const COVERAGE_URL = `/coverage?target_id=${gracie}`;
const SETTLE_TIMEOUT_MS = 15_000;
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

async function seedProposals(request: APIRequestContext, variant: string): Promise<void> {
  const response = await request.post(`${apiOrigin()}/__mock/stage11/seed`, {
    data: { variants: { proposals: variant } },
  });
  expect(response.ok()).toBe(true);
}

async function openCoverage(page: Page): Promise<void> {
  await page.goto(COVERAGE_URL);
  await expect(page.locator("[data-slot=heatmap-grid]")).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
}

const MARKED_EMPTY = 'button[data-status="empty"]:has([data-slot=proposed-mark])';
const UNMARKED_EMPTY = 'button[data-status="empty"]:not(:has([data-slot=proposed-mark]))';

test.describe("coverage markers", () => {
  test("marks proposed cells and counts them in the legend", async ({ page }) => {
    await openCoverage(page);
    const marks = page.locator("[data-slot=heatmap-grid] [data-slot=proposed-mark]");
    await expect(marks.first()).toBeVisible();
    const count = await marks.count();
    expect(count).toBeGreaterThan(0);
    const legend = page.locator("[data-slot=legend-proposed]");
    await expect(legend).toContainText("Proposed");
    await expect(legend.locator("[data-slot=legend-proposed-count]")).toHaveText(String(count));
    await expect(
      page.getByRole("button", { name: /proposed in the test proposal/ }).first(),
    ).toBeVisible();
  });

  test("shows no marker and no legend entry without a proposal", async ({ page, request }) => {
    await seedProposals(request, "empty");
    await openCoverage(page);
    await expect(page.locator("[data-slot=proposed-mark]")).toHaveCount(0);
    await expect(page.locator("[data-slot=legend-proposed]")).toHaveCount(0);
  });

  test("lists the proposal items of a cell in the sheet and links to the board", async ({
    page,
  }) => {
    await openCoverage(page);
    await page.locator(MARKED_EMPTY).first().click();
    const sheet = page.locator("[data-slot=cell-sheet]");
    const section = sheet.locator("[data-slot=cell-proposal-items]");
    await expect(section).toBeVisible();
    const link = section.getByRole("link").first();
    await expect(link).not.toHaveText("Item of the test proposal");
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/targets/${gracie}/proposal\\?.*area=`));
    await expect(page.getByRole("heading", { level: 2, name: "Test proposal" })).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });
  });

  test("drops the marker from cells whose item is declined", async ({ page }) => {
    await openCoverage(page);
    const marked = page.locator(MARKED_EMPTY).first();
    const cellId = await marked.getAttribute("data-cell-id");
    await marked.click();
    const titles = await page
      .locator("[data-slot=cell-proposal-items]")
      .getByRole("link")
      .allTextContents();
    expect(titles.length).toBeGreaterThan(0);
    await page.keyboard.press("Escape");

    const sessionToken = (await (await page.request.get("/api/session/api-token")).json()) as {
      token: string;
    };
    const headers = { Authorization: `Bearer ${sessionToken.token}` };
    const proposal = (await (
      await page.request.get(`${apiOrigin()}/api/v1/targets/${gracie}/proposal`, { headers })
    ).json()) as { items: Array<{ id: string; title: string; status: string }> };
    for (const item of proposal.items.filter((entry) => titles.includes(entry.title))) {
      if (item.status !== "authored") {
        await page.request.patch(`${apiOrigin()}/api/v1/proposal-items/${item.id}`, {
          headers,
          data: { status: "declined" },
        });
      }
    }
    await page.reload();
    await expect(page.locator("[data-slot=heatmap-grid]")).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });
    const after = page.locator(`button[data-cell-id="${cellId}"]`);
    await expect(after).toBeVisible();
    await expect(after.locator("[data-slot=proposed-mark]")).toHaveCount(0);
  });

  test("puts the item ids in the author command when every selected cell maps to items", async ({
    page,
  }) => {
    await openCoverage(page);
    await page.getByRole("switch", { name: "Select cells" }).click();
    const first = page.locator(MARKED_EMPTY).nth(0);
    const second = page.locator(MARKED_EMPTY).nth(1);
    const cellIds = [
      await first.getAttribute("data-cell-id"),
      await second.getAttribute("data-cell-id"),
    ];
    await first.click();
    await second.click();
    const bar = page.locator("[data-slot=selection-bar]");
    await expect(bar).toContainText("2 cells selected");
    const command = (await bar.locator("code").textContent()) ?? "";
    expect(command.startsWith("/tessa:author ")).toBe(true);
    for (const cellId of cellIds) {
      expect(command).not.toContain(cellId ?? "");
    }
  });

  test("falls back to cell ids when one selected cell has no item", async ({ page }) => {
    await openCoverage(page);
    await page.getByRole("switch", { name: "Select cells" }).click();
    const marked = page.locator(MARKED_EMPTY).first();
    const plain = page.locator(UNMARKED_EMPTY).first();
    const ids = [
      await marked.getAttribute("data-cell-id"),
      await plain.getAttribute("data-cell-id"),
    ];
    await marked.click();
    await plain.click();
    const command = (await page.locator("[data-slot=selection-bar] code").textContent()) ?? "";
    for (const cellId of ids) {
      expect(command).toContain(cellId ?? "");
    }
  });
});

test.describe("catalog risk chip", () => {
  test("shows the proposal risk next to the confidence chip", async ({ page }) => {
    await page.goto(`/catalog?target_id=${gracie}`);
    const card = page.getByRole("article", { name: "smart_log.read.open_maintenance" });
    await expect(card).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    const chip = card.locator("[data-slot=proposal-risk-chip]");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/^(High|Medium|Low) risk$/);
    await expect(chip).toHaveAttribute("title", "Risk from the test proposal");
  });

  test("shows no risk chip without a proposal", async ({ page, request }) => {
    await seedProposals(request, "empty");
    await page.goto(`/catalog?target_id=${gracie}`);
    await expect(
      page.getByRole("article", { name: "smart_log.read.open_maintenance" }),
    ).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(page.locator("[data-slot=proposal-risk-chip]")).toHaveCount(0);
  });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe on the coverage map with markers in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("map, legend and cell sheet", async ({ page }) => {
      await openCoverage(page);
      await expect(page.locator("[data-slot=legend-proposed]")).toBeVisible();
      await expectNoAxeViolations(page);
      await page.locator(MARKED_EMPTY).first().click();
      await expect(page.locator("[data-slot=cell-proposal-items]")).toBeVisible();
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((item) => item.effect?.getComputedTiming().iterations !== Infinity)
            .map((item) => item.finished),
        ),
      );
      await expectNoAxeViolations(page);
    });
  });
}
