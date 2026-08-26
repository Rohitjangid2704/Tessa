import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STAGE_ONE_IDS } from "../../../mocks/stage1/seed";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { apiOrigin } from "../helpers/env";
import { signInThroughForm } from "../helpers/login";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const { gracie } = STAGE_ONE_IDS;
const OVERVIEW_URL = `/targets/${gracie}`;
const ACTIVITY_URL = "/settings/activity";
const SEEDED_SESSION_ID = "0198f6f2-aaaa-7bbb-8ccc-000000000011";
const SETTLE_TIMEOUT_MS = 15_000;
const FIRST_PAGE_BUDGET_MS = 8_000;
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

async function seed(
  request: APIRequestContext,
  variants: { agent_sessions?: string; audit?: string },
): Promise<void> {
  const response = await request.post(`${apiOrigin()}/__mock/stage11/seed`, {
    data: { variants },
  });
  expect(response.ok()).toBe(true);
}

async function fireSession(
  request: APIRequestContext,
  data: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await request.post(`${apiOrigin()}/__mock/stage11/agent-session`, { data });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: string };
}

function panel(page: Page) {
  return page.locator('[data-slot="agent-sessions-panel"]');
}

function sessionRows(page: Page) {
  return panel(page).locator('[data-slot="agent-session-row"]');
}

function auditTable(page: Page) {
  return page.getByRole("table", { name: "Audit events" });
}

function auditRows(page: Page) {
  return auditTable(page).locator('[data-slot="audit-row"]');
}

async function scrollAuditTableToEnd(page: Page): Promise<void> {
  await auditTable(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
}

test.describe("agent sessions panel", () => {
  test("lists an active and an ended session under the latest bundle", async ({ page }) => {
    await page.goto(OVERVIEW_URL);

    await expect(panel(page)).toBeVisible();
    await expect(sessionRows(page)).toHaveCount(2);
    await expect(
      page.getByRole("heading", { level: 2, name: "Claude Code sessions" }),
    ).toBeVisible();

    const active = sessionRows(page).filter({ hasText: "Member" });
    await expect(active).toHaveAttribute("data-state", "active");
    await expect(active).toContainText("Active");
    await expect(active).toContainText("gracie");
    await expect(active).toContainText("3 writes");

    const ended = sessionRows(page).filter({ hasText: "Admin" });
    await expect(ended).toHaveAttribute("data-state", "ended");
    await expect(ended).toContainText("gracie-backend");
    await expect(ended).toContainText("Discovered the bundle, filled the environment");
    await expect(ended).toContainText("9 writes");

    const order = await page
      .locator('[data-slot="latest-bundle-card"], [data-slot="agent-sessions-panel"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-slot")));
    expect(order).toEqual(["latest-bundle-card", "agent-sessions-panel"]);
  });

  test("invites the first session when there is none", async ({ page, request }) => {
    await seed(request, { agent_sessions: "none" });
    await page.goto(OVERVIEW_URL);

    await expect(
      panel(page).getByText(/No Claude Code session has worked on this target/),
    ).toBeVisible();
    await expect(sessionRows(page)).toHaveCount(0);
  });

  test("marks an open session older than twelve hours as inactive", async ({ page, request }) => {
    await seed(request, { agent_sessions: "none" });
    await fireSession(request, { cwd_label: "forgotten", started_hours_ago: 14 });
    await page.goto(OVERVIEW_URL);

    const row = sessionRows(page).filter({ hasText: "forgotten" });
    await expect(row).toHaveAttribute("data-state", "inactive");
    await expect(row.getByText("Inactive")).toBeVisible();
    await expect(row.getByText("Active", { exact: true })).toHaveCount(0);
  });

  test("clamps a long summary to two lines and expands it", async ({ page, request }) => {
    await seed(request, { agent_sessions: "none" });
    await fireSession(request, {
      cwd_label: "long-summary",
      ended: true,
      summary: `Explained two findings and re-ran the failing scenarios. ${"More detail. ".repeat(20)}`,
    });
    await page.goto(OVERVIEW_URL);

    const summary = panel(page).locator('[data-slot="agent-session-summary"]');
    await expect(summary).toHaveClass(/line-clamp-2/);
    await panel(page).getByRole("button", { name: "Show more" }).click();
    await expect(summary).not.toHaveClass(/line-clamp-2/);
    await expect(panel(page).getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("updates live when a session starts, gets a summary and ends", async ({ page, request }) => {
    await seed(request, { agent_sessions: "none" });
    await page.goto(OVERVIEW_URL);
    await expect(panel(page).getByText(/No Claude Code session has worked/)).toBeVisible();
    await page.waitForTimeout(1_500);

    const started = await fireSession(request, { cwd_label: "live-folder" });
    const row = sessionRows(page).filter({ hasText: "live-folder" });
    await expect(row).toHaveAttribute("data-state", "active", { timeout: SETTLE_TIMEOUT_MS });
    await expect(row).toHaveAttribute("data-session-id", started.id);

    await fireSession(request, { session_id: started.id, summary: "Fixed the flaky login test." });
    await expect(row).toContainText("Fixed the flaky login test.", { timeout: SETTLE_TIMEOUT_MS });

    await fireSession(request, { session_id: started.id, ended: true });
    await expect(row).toHaveAttribute("data-state", "ended", { timeout: SETTLE_TIMEOUT_MS });
    await expect(row.getByText("Active", { exact: true })).toHaveCount(0);
  });

  test("shows the newest five sessions and counts the rest", async ({ page, request }) => {
    await seed(request, { agent_sessions: "many" });
    await page.goto(OVERVIEW_URL);

    await expect(sessionRows(page)).toHaveCount(5);
    await expect(panel(page).getByText("Showing the newest 5 of 40 sessions.")).toBeVisible();
  });
});

test.describe("audit log", () => {
  test("lists the events newest first with every column", async ({ page }) => {
    await page.goto(ACTIVITY_URL);

    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expect(auditRows(page).first()).toBeVisible();
    const headers = await auditTable(page).getByRole("columnheader").allTextContents();
    expect(headers).toEqual(["Time", "Actor", "Action", "Subject", "Via", "Session", "Request"]);

    const mcp = auditRows(page).filter({ hasText: "Write with a personal token" }).first();
    await expect(mcp).toContainText("Claude Code");
    await expect(mcp).toContainText("API route");
    await expect(mcp.locator('[data-slot="audit-detail"]')).toContainText("method: POST");
    await expect(mcp.getByRole("button", { name: /Copy request id req-/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("keeps the via filter in the URL and survives a reload", async ({ page }) => {
    await page.goto(ACTIVITY_URL);
    await expect(auditRows(page).first()).toBeVisible();

    await page.getByLabel("Via").click();
    await page.getByRole("option", { name: "Claude Code" }).click();

    await expect(page).toHaveURL(/[?&]via=mcp\b/);
    await expect(auditRows(page).first()).toHaveAttribute("data-via", "mcp");
    const vias = await auditRows(page).evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-via")),
    );
    expect(vias.length).toBeGreaterThan(0);
    for (const via of vias) {
      expect(via).toBe("mcp");
    }

    await page.reload();
    await expect(page.getByLabel("Via")).toContainText("Claude Code");
    await expect(auditRows(page).first()).toHaveAttribute("data-via", "mcp");
    await expect(page.getByText("1 filter active")).toBeAttached();
  });

  test("filters by actor, subject type and since, then clears everything", async ({ page }) => {
    await page.goto(ACTIVITY_URL);
    await expect(auditRows(page).first()).toBeVisible();

    await page.getByLabel("Actor").click();
    await page.getByRole("option", { name: "Member" }).click();
    await page.getByLabel("Subject type").click();
    await page.getByRole("option", { name: "API route" }).click();
    await page.getByLabel("Since").fill("2020-01-01");

    await expect(page).toHaveURL(/actor=[0-9a-f-]{36}/);
    await expect(page).toHaveURL(/subject_type=route/);
    await expect(page).toHaveURL(/since=2020-01-01/);
    await expect(auditRows(page).first()).toContainText("API route");

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).not.toHaveURL(/actor=|subject_type=|since=/);
  });

  test("opens the events of one session from its link", async ({ page }) => {
    await page.goto(ACTIVITY_URL);
    const link = page.getByRole("link", { name: /Show the events of session/ }).first();
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(new RegExp(`session=${SEEDED_SESSION_ID}`));
    await expect(
      page.getByRole("button", { name: /Remove the filter on session 0198f6f2/ }),
    ).toBeVisible();
    await expect(auditRows(page).first()).toBeVisible();
    const hrefs = await auditRows(page).evaluateAll((rows) =>
      rows.map((row) => row.querySelector("a")?.getAttribute("href")),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toContain(SEEDED_SESSION_ID);
    }

    await page.getByRole("button", { name: /Remove the filter on session/ }).click();
    await expect(page).not.toHaveURL(/session=/);
  });

  test("scrolls through 2,000 rows, loading pages as the window reaches the end", async ({
    page,
    request,
  }) => {
    await seed(request, { audit: "many" });
    const startedAt = Date.now();
    await page.goto(ACTIVITY_URL);
    await expect(auditRows(page).first()).toBeVisible();
    expect(Date.now() - startedAt).toBeLessThan(FIRST_PAGE_BUDGET_MS);

    const table = auditTable(page);
    await expect(table).toHaveAttribute("aria-rowcount", "2001");
    expect(await auditRows(page).count()).toBeLessThan(60);
    expect(Number(await table.getAttribute("data-loaded"))).toBeLessThan(2000);

    await expect
      .poll(
        async () => {
          await scrollAuditTableToEnd(page);
          return Number(await table.getAttribute("data-loaded"));
        },
        { timeout: 60_000, intervals: [200] },
      )
      .toBe(2000);
    await expect(page.getByText("Showing 2000 of 2000 events")).toBeVisible();
    expect(await auditRows(page).count()).toBeLessThan(60);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  });

  test("shows an empty log and an empty filtered result", async ({ page, request }) => {
    await seed(request, { audit: "empty" });
    await page.goto(ACTIVITY_URL);
    await expect(page.getByRole("heading", { name: "The audit log is empty" })).toBeVisible();

    await seed(request, { audit: "default" });
    await page.goto(`${ACTIVITY_URL}?via=svc`);
    await expect(page.getByRole("heading", { name: "No events match" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(page).not.toHaveURL(/via=/);
    await expect(auditRows(page).first()).toBeVisible();
  });
});

for (const account of [
  { role: "member", email: "member@tessa.local", password: "dev-only-member-password-1" },
  { role: "viewer", email: "viewer@tessa.local", password: "dev-only-viewer-password-1" },
] as const) {
  test.describe(`audit log for a ${account.role}`, () => {
    test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

    test("is refused and absent from the settings menu", async ({ page }) => {
      await page.goto("/login");
      await signInThroughForm(page, account);
      await page.goto(ACTIVITY_URL);

      await expect(page.getByRole("heading", { name: "Admin access required" })).toBeVisible();
      await expect(page.locator('[data-slot="audit-table"]')).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Personal tokens" })).toBeVisible();
    });

    test("still sees the sessions panel on the target overview", async ({ page }) => {
      await page.goto("/login");
      await signInThroughForm(page, account);
      await page.goto(OVERVIEW_URL);

      await expect(sessionRows(page)).toHaveCount(2);
    });
  });
}
