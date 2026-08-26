import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STAGE_ONE_IDS } from "../../../mocks/stage1/seed";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { expectNoAxeViolations } from "../helpers/axe";
import { apiOrigin } from "../helpers/env";
import { signInThroughForm } from "../helpers/login";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const { gracie } = STAGE_ONE_IDS;
const BOARD_URL = `/targets/${gracie}/proposal`;
const SETTLE_TIMEOUT_MS = 15_000;
const FAILED_RESOURCE_LOG = "Failed to load resource";

const OPEN_ISSUES = "List maintenance issues that are still open, optionally per room";
const CLOSE_ISSUE = "Close a maintenance issue after the user confirms";
const EXPLAIN_ISSUE = "Explain one maintenance issue with its history and the assigned technician";

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

async function apiToken(page: Page): Promise<string> {
  const response = await page.request.get("/api/session/api-token");
  return ((await response.json()) as { token: string }).token;
}

interface DocItem {
  key: string;
  title: string;
  feature: string;
  risk?: "high" | "medium" | "low";
  evidence?: string;
  note?: string;
}

async function putProposal(page: Page, items: DocItem[]): Promise<void> {
  const token = await apiToken(page);
  const headers = { Authorization: `Bearer ${token}` };
  const target = await page.request.get(`${apiOrigin()}/api/v1/targets/${gracie}`, { headers });
  const targetToken = ((await target.json()) as { target_token: string }).target_token;
  const doc = {
    schema: "http://localhost:8000/schemas/proposal.v1.json",
    target_token: targetToken,
    items: items.map((item) => ({
      key: item.key,
      title: item.title,
      area: "Smart Log",
      feature_ids: [item.feature],
      kind: "api",
      risk: item.risk ?? "medium",
      reasons: [{ code: "recent_change", note: item.note ?? "Touched in 4 commits" }],
      needs: ["seed"],
      depth: "smoke",
      estimate: { scenarios: 3, minutes: 5 },
      confidence: "high",
      evidence: item.evidence ?? "src/smart_log/handlers.py",
    })),
  };
  const response = await page.request.put(`${apiOrigin()}/api/v1/targets/${gracie}/proposal`, {
    headers,
    data: { yaml: JSON.stringify(doc) },
  });
  expect(response.status()).toBe(200);
}

const SMART_LOG_ITEMS: DocItem[] = [
  {
    key: "smart-log.open",
    title: OPEN_ISSUES,
    feature: "smart_log.read.open_maintenance",
    risk: "high",
  },
  { key: "smart-log.close", title: CLOSE_ISSUE, feature: "smart_log.write.close_issue" },
  {
    key: "smart-log.detail",
    title: EXPLAIN_ISSUE,
    feature: "smart_log.read.issue_detail",
    risk: "low",
  },
];

function card(page: Page, title: string) {
  return page.getByRole("article", { name: title });
}

function footer(page: Page) {
  return page.locator("[data-slot=proposal-footer]");
}

async function openBoard(page: Page): Promise<void> {
  await page.goto(BOARD_URL);
  await expect(page.getByRole("heading", { level: 2, name: "Test proposal" })).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
}

test.describe("proposal board", () => {
  test("is a tab of the target and groups 60 items across six areas", async ({ page }) => {
    await page.goto(`/targets/${gracie}`);
    await page
      .getByRole("navigation", { name: "Target sections" })
      .getByRole("link", { name: "Proposal" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/targets/${gracie}/proposal$`));
    await expect(page.getByText(/^60 items: /)).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(page.locator("[data-slot=proposal-stale]")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 3 }).first()).toBeVisible();
    const board = page.locator("[data-slot=proposal-board]");
    await expect(board).toHaveAttribute("data-virtualized", "true");
    const rendered = await board.getByRole("article").count();
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);
  });

  test("scrolls through the large variant to the last item", async ({ page, request }) => {
    await seedProposals(request, "large");
    await openBoard(page);
    await expect(page.getByText(/^200 items: /)).toBeVisible();
    const board = page.locator("[data-slot=proposal-board]");
    await expect(board).toHaveAttribute("data-virtualized", "true");
    const firstTitle = await board.getByRole("article").first().getAttribute("data-item-id");
    await board.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect
      .poll(async () => board.getByRole("article").last().getAttribute("data-item-id"))
      .not.toBe(firstTitle);
    await expect(board.getByRole("article").last()).toHaveAttribute(
      "data-area",
      "Streaming & Jobs",
    );
    const rendered = await board.getByRole("article").count();
    expect(rendered).toBeLessThan(40);
  });

  test("ticks two items, plans from the selection and lands on the catalog with the plan loaded", async ({
    page,
  }) => {
    await page.goto("/");
    await putProposal(page, SMART_LOG_ITEMS);
    await openBoard(page);

    await expect(footer(page)).toContainText("0 items selected");
    await expect(page.getByRole("button", { name: "Plan from selection" })).toBeDisabled();

    await card(page, CLOSE_ISSUE)
      .getByRole("checkbox", { name: `Select ${CLOSE_ISSUE}` })
      .check();
    await card(page, EXPLAIN_ISSUE)
      .getByRole("checkbox", { name: `Select ${EXPLAIN_ISSUE}` })
      .check();
    await expect(footer(page)).toContainText("2 items selected");
    await expect(footer(page).locator("code")).toContainText("/tessa:author ");

    await page.getByRole("button", { name: "Plan from selection" }).click();
    await expect(page).toHaveURL(new RegExp(`/catalog\\?.*target_id=${gracie}`), {
      timeout: SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByText(/^Loaded ".*" into the builder$/)).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });
    await expect(page).not.toHaveURL(/[?&]plan=/);
    await expect(
      page.getByRole("checkbox", { name: "Select smart_log.write.close_issue" }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Select smart_log.read.issue_detail" }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Select smart_log.read.open_maintenance" }),
    ).not.toBeChecked();
  });

  test("declines an item with a note that survives a reload, then restores it", async ({
    page,
  }) => {
    await page.goto("/");
    await putProposal(page, SMART_LOG_ITEMS);
    await openBoard(page);

    await page.getByRole("button", { name: `Decline ${OPEN_ISSUES}` }).click();
    const form = page.getByRole("form", { name: `Decline ${OPEN_ISSUES}` });
    await form.getByRole("textbox").fill("Covered by the vendor contract tests");
    await form.getByRole("button", { name: "Decline item" }).click();

    await expect(card(page, OPEN_ISSUES)).toHaveAttribute("data-status", "declined");
    await expect(card(page, OPEN_ISSUES)).toContainText("Covered by the vendor contract tests");

    await page.reload();
    await expect(card(page, OPEN_ISSUES)).toHaveAttribute("data-status", "declined");
    await expect(card(page, OPEN_ISSUES)).toContainText("Covered by the vendor contract tests");

    await page.getByRole("button", { name: `Restore ${OPEN_ISSUES}` }).click();
    await expect(card(page, OPEN_ISSUES)).toHaveAttribute("data-status", "proposed");
    await expect(card(page, OPEN_ISSUES)).not.toContainText("Covered by the vendor contract tests");
  });

  test("selects and clears a whole area, leaving declined items alone", async ({ page }) => {
    await page.goto("/");
    await putProposal(page, SMART_LOG_ITEMS);
    await openBoard(page);
    await page.getByRole("button", { name: `Decline ${EXPLAIN_ISSUE}` }).click();
    await page.getByRole("button", { name: "Decline item" }).click();
    await expect(card(page, EXPLAIN_ISSUE)).toHaveAttribute("data-status", "declined");

    await page.getByRole("button", { name: "Select all proposed items in Smart Log" }).click();
    await expect(footer(page)).toContainText("2 items selected");
    await expect(card(page, EXPLAIN_ISSUE)).toHaveAttribute("data-status", "declined");

    await page.getByRole("button", { name: "Clear the selection in Smart Log" }).click();
    await expect(footer(page)).toContainText("0 items selected");
  });

  test("filters by risk and keeps the filter in the URL", async ({ page }) => {
    await page.goto("/");
    await putProposal(page, SMART_LOG_ITEMS);
    await page.goto(`${BOARD_URL}?risk=high`);
    await expect(card(page, OPEN_ISSUES)).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(card(page, CLOSE_ISSUE)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Risk: 1 selected/ })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(card(page, CLOSE_ISSUE)).toBeVisible();
    await expect(page).not.toHaveURL(/risk=/);
  });

  test("shows the stale badge with the propose command", async ({ page, request }) => {
    await seedProposals(request, "stale");
    await openBoard(page);
    const stale = page.locator("[data-slot=proposal-stale]");
    await expect(stale).toBeVisible();
    await expect(stale).toContainText("Stale");
    await expect(stale.locator("code")).toHaveText("/tessa:propose");
  });

  test("shows the empty state with the propose command", async ({ page, request }) => {
    await seedProposals(request, "empty");
    await page.goto(BOARD_URL);
    await expect(page.getByRole("heading", { name: "No test proposal yet" })).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });
    await expect(page.locator("[data-slot=proposal-empty] code")).toHaveText("/tessa:propose");
  });

  test("renders proposal text as text, never as HTML", async ({ page }) => {
    await page.goto("/");
    const title = '<img src="x" onerror="window.__pwned=1">Close it';
    await putProposal(page, [
      {
        key: "html.title",
        title,
        feature: "smart_log.write.close_issue",
        evidence: "<script>window.__pwned=1</script>",
        note: "<b>bold</b>",
      },
    ]);
    await openBoard(page);
    await expect(card(page, title)).toBeVisible();
    await expect(card(page, title)).toContainText("<script>window.__pwned=1</script>");
    await expect(card(page, title)).toContainText("<b>bold</b>");
    await expect(page.locator("img[src='x']")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
  });

  test("updates when another person ticks an item", async ({ page }) => {
    await page.goto("/");
    await putProposal(page, SMART_LOG_ITEMS);
    await openBoard(page);
    await expect(page.locator("[data-slot=proposal-feed]")).toHaveAttribute("data-status", "live", {
      timeout: SETTLE_TIMEOUT_MS,
    });
    const token = await apiToken(page);
    const headers = { Authorization: `Bearer ${token}` };
    const proposal = (await (
      await page.request.get(`${apiOrigin()}/api/v1/targets/${gracie}/proposal`, { headers })
    ).json()) as { items: Array<{ id: string; title: string }> };
    const item = proposal.items.find((entry) => entry.title === CLOSE_ISSUE);
    expect(item).toBeDefined();
    const response = await page.request.patch(`${apiOrigin()}/api/v1/proposal-items/${item?.id}`, {
      headers,
      data: { status: "selected" },
    });
    expect(response.status()).toBe(200);
    await expect(card(page, CLOSE_ISSUE)).toHaveAttribute("data-status", "selected", {
      timeout: SETTLE_TIMEOUT_MS,
    });
    await expect(footer(page)).toContainText("1 item selected");
  });
});

test.describe("proposal board for a viewer", () => {
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

  test("is read-only", async ({ page }) => {
    await page.goto("/login");
    await signInThroughForm(page, {
      email: "viewer@tessa.local",
      password: "dev-only-viewer-password-1",
    });
    await page.goto(`${BOARD_URL}?area=Smart%20Log`);
    await expect(page.getByRole("article").first()).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Decline/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Select all/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Plan from selection" })).toHaveCount(0);
  });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe on the proposal board in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("board with every item state", async ({ page }) => {
      await page.goto(`${BOARD_URL}?area=Smart%20Log`);
      await expect(page.getByRole("article").first()).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
      await expectNoAxeViolations(page);
    });

    test("declining form and a stale proposal", async ({ page, request }) => {
      await seedProposals(request, "stale");
      await page.goto(`${BOARD_URL}?status=proposed&area=Reports`);
      await expect(page.getByRole("article").first()).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
      await page
        .getByRole("button", { name: /^Decline/ })
        .first()
        .click();
      await expect(page.getByRole("form")).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("empty state", async ({ page, request }) => {
      await seedProposals(request, "empty");
      await page.goto(BOARD_URL);
      await expect(page.getByRole("heading", { name: "No test proposal yet" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expectNoAxeViolations(page);
    });

    test("large variant while virtualised", async ({ page, request }) => {
      await seedProposals(request, "large");
      await openBoard(page);
      await expectNoAxeViolations(page);
    });
  });
}
