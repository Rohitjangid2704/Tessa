import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ORACLE_RESULT_IDS, ORACLE_TEMPLATE_IDS } from "../../../mocks/fixtures/oracle-templates";
import { STAGE_ONE_IDS } from "../../../mocks/stage1/seed";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { expectNoAxeViolations } from "../helpers/axe";
import { apiOrigin } from "../helpers/env";
import { signInThroughForm } from "../helpers/login";
import { clearMockFaults, resetMockApi, setMockFaults } from "../helpers/mock-api";

const { gracie, billing } = STAGE_ONE_IDS;
const SETTLE_TIMEOUT_MS = 15_000;
const RELOADS = 12;
const HYDRATION_TEST_TIMEOUT_MS = 120_000;
const MAX_TABS = 120;
const FAILED_RESOURCE_LOG = "Failed to load resource";
const RESULT_REQUEST = /\/api\/v1\/oracle-results\//;
const RUN_REQUEST = /\/api\/v1\/oracle-templates\/[0-9a-f-]+\/runs$/;

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

async function configureOracle(
  request: APIRequestContext,
  body: { seed?: "default" | "empty"; oracle_settle_ms?: number | null },
): Promise<void> {
  const response = await request.post(`${apiOrigin()}/__mock/stage3/seed`, { data: body });
  expect(response.ok()).toBe(true);
}

function templateButton(page: Page, name: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${name}`) });
}

function approvalBar(page: Page): Locator {
  return page.getByRole("region", { name: "Review" });
}

function approveButton(page: Page): Locator {
  return approvalBar(page).getByRole("button", { name: "Approve", exact: true });
}

function rejectButton(page: Page): Locator {
  return approvalBar(page).getByRole("button", { name: "Reject", exact: true });
}

function detail(page: Page): Locator {
  return page.getByRole("article");
}

function resultView(page: Page): Locator {
  return page.locator("[data-slot=result-view]");
}

async function openOracle(
  page: Page,
  search = `?target_id=${gracie}`,
  waitForList = true,
): Promise<void> {
  await page.goto(`/oracle${search}`);
  await expect(page.getByRole("search", { name: "Filter templates" })).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
  if (waitForList) {
    await expect(templateButton(page, "open_maintenance")).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });
  }
}

async function openTemplate(page: Page, templateId: string, extra = ""): Promise<void> {
  await openOracle(page, `?target_id=${gracie}&template_id=${templateId}${extra}`);
  await expect(detail(page)).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
  await expect(page.getByRole("button", { name: "Run query" })).toBeEnabled({
    timeout: SETTLE_TIMEOUT_MS,
  });
}

async function runQuery(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Run query" }).click();
}

async function runAndFinish(page: Page): Promise<void> {
  await runQuery(page);
  await expect(page.locator("[data-slot=result-view][data-status=pending]")).toHaveCount(0, {
    timeout: SETTLE_TIMEOUT_MS,
  });
  await expect(resultView(page)).toBeVisible();
}

async function tabUntil(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < MAX_TABS; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("the control was not reachable with the Tab key");
}

test.describe("oracle template list", () => {
  test("asks for a target, then lists the templates of the one that is chosen", async ({
    page,
  }) => {
    await page.goto("/oracle");

    await expect(page.getByRole("heading", { level: 1, name: "Oracle" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Choose a target" })).toBeVisible();
    await page.getByRole("combobox", { name: "Choose a target" }).click();
    await page.getByRole("option", { name: "Gracie" }).click();

    await expect(page).toHaveURL(new RegExp(`/oracle\\?target_id=${gracie}$`));
    await expect(templateButton(page, "open_maintenance")).toBeVisible();
    await expect(page.getByText("Showing 11 of 11 templates")).toBeVisible();
  });

  test("shows language, approval and read-only verification on every template", async ({
    page,
  }) => {
    await openOracle(page);

    await expect(page.locator("[data-template-id]")).toHaveCount(11);
    await expect(templateButton(page, "staff_roster")).toContainText("Python");
    await expect(templateButton(page, "staff_roster")).toContainText("Approved");
    await expect(templateButton(page, "legacy_room_status")).toContainText("Rejected");
    await expect(templateButton(page, "open_maintenance")).toContainText("Unreviewed");
    await expect(templateButton(page, "refresh_room_snapshot")).toContainText(
      "Not verified read-only",
    );
    await expect(page.getByRole("heading", { level: 2, name: "Select a template" })).toBeVisible();
  });

  test("writes filters to the URL, narrows the list, restores them on reload and clears them", async ({
    page,
  }) => {
    await openOracle(page);

    await page.getByRole("button", { name: /^Approval: / }).click();
    await page.getByRole("checkbox", { name: "Rejected", exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/approval=rejected/);
    await expect(page.locator("[data-template-id]")).toHaveCount(1);
    await expect(templateButton(page, "legacy_room_status")).toBeVisible();

    await page.reload();
    await expect(page.locator("[data-template-id]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Approval: 1 selected" })).toBeVisible();

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).not.toHaveURL(/approval=/);
    await expect(page.locator("[data-template-id]")).toHaveCount(11);

    await page.getByRole("searchbox", { name: "Feature" }).fill("streaming.job.escalation_sweep");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/feature_id=streaming\.job\.escalation_sweep/);
    await expect(page.locator("[data-template-id]")).toHaveCount(1);
    await expect(templateButton(page, "escalation_rules")).toBeVisible();
  });

  test("explains a filter that matches nothing and offers every template again", async ({
    page,
  }) => {
    await openOracle(page, `?target_id=${gracie}&approval=approved&feature_id=nothing.here`, false);

    await expect(page.getByRole("heading", { name: "No templates match" })).toBeVisible();
    await page.getByRole("button", { name: "Show all templates" }).click();

    await expect(page.locator("[data-template-id]")).toHaveCount(11);
  });

  test("guides to the bundles when the bundle has no oracle templates", async ({
    page,
    request,
  }) => {
    await configureOracle(request, { seed: "empty" });
    await page.goto(`/oracle?target_id=${gracie}`);

    await expect(page.getByRole("heading", { name: "No oracle templates" })).toBeVisible();
    await expect(
      page.getByText(/Re-run the Discovery prompt, or send the Fix-up prompt/),
    ).toBeVisible();
    await page.getByRole("link", { name: "Open the bundles of this target" }).click();
    await expect(page).toHaveURL(new RegExp(`/targets/${gracie}/bundles$`));
  });

  test("shows the same guidance for a target without a valid bundle", async ({ page }) => {
    await page.goto(`/oracle?target_id=${billing}`);

    await expect(page.getByRole("heading", { name: "No oracle templates" })).toBeVisible();
  });

  test("shows the request id and recovers after a server error", async ({ page }) => {
    let failures = 3;
    await page.route(/\/api\/v1\/oracle-templates(\?|$)/, async (route) => {
      if (failures > 0) {
        failures -= 1;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "internal_error",
              message: "Boom",
              request_id: "req-e2e-500",
              details: [],
            },
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.goto(`/oracle?target_id=${gracie}`);

    const failure = page.getByRole("main").getByRole("alert");
    await expect(failure).toContainText("Could not load the oracle templates");
    await expect(failure).toContainText("Request ID: req-e2e-500");
    await failure.getByRole("button", { name: "Try again" }).click();

    await expect(templateButton(page, "open_maintenance")).toBeVisible();
  });
});

test.describe("oracle template detail", () => {
  test("shows the source in a read-only editor with the badges, features and parameters", async ({
    page,
  }) => {
    await openOracle(page);
    await templateButton(page, "open_maintenance").click();

    await expect(page).toHaveURL(new RegExp(`template_id=${ORACLE_TEMPLATE_IDS.openMaintenance}`));
    await expect(page.getByRole("heading", { level: 2, name: "open_maintenance" })).toBeVisible();
    await expect(detail(page).getByText("Read-only verified")).toBeVisible();
    await expect(detail(page).getByText("smart_log.read.open_maintenance")).toBeVisible();
    const editor = page.locator("[data-slot=code-view][data-language=sql]");
    await expect(editor).toContainText("smart_log", { timeout: SETTLE_TIMEOUT_MS });
    await expect(
      editor.getByRole("textbox", { name: "Source of open_maintenance" }),
    ).toBeAttached();
    await editor.locator(".view-lines").click();
    await page.keyboard.type("ZZZ_TYPED_TEXT");
    await expect(editor).not.toContainText("ZZZ_TYPED_TEXT");
    await expect(editor).toContainText("smart_log");
    await expect(page.getByLabel(/^Tenant/)).toHaveValue("gracie-demo");
    await expect(page.getByLabel(/^As of/)).toHaveValue("2026-10-01");
    await expect(page.getByRole("combobox", { name: /^Role/ })).toContainText("front_desk");
    await expect(page.getByRole("switch", { name: /^Include closed/ })).not.toBeChecked();
  });

  test("shows python source for a python template", async ({ page }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.staffRoster);

    await expect(page.locator("[data-slot=code-view][data-language=python]")).toContainText(
      "def run",
      { timeout: SETTLE_TIMEOUT_MS },
    );
    await expect(detail(page).getByText("Python", { exact: true }).first()).toBeVisible();
  });

  test("warns that a template is not verified read-only and keeps Run available", async ({
    page,
  }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.rawSqlProbe);

    await expect(page.locator("[data-slot=read-only-warning]")).toContainText(
      "Not verified as read-only",
    );
    await expect(approveButton(page)).toBeDisabled();
    await runAndFinish(page);
    await expect(approveButton(page)).toBeDisabled();
    await expect(
      page.getByText(/not verified as read-only, so it cannot be approved/),
    ).toBeVisible();
  });

  test("tells when the selected template does not exist", async ({ page }) => {
    await page.goto(`/oracle?target_id=${gracie}&template_id=0198f6f2-4c2a-7d10-9c1e-000000000000`);

    await expect(page.getByRole("heading", { name: "Template not found" })).toBeVisible();
    await page.getByRole("button", { name: "Back to the list" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Select a template" })).toBeVisible();
  });

  test("keeps the earlier runs and shows the one that is picked", async ({ page }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);

    const history = page.getByRole("region", { name: "History" });
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await history.getByRole("button", { name: /^Show/ }).nth(1).click();

    await expect(page).toHaveURL(new RegExp(`result_id=${ORACLE_RESULT_IDS.openMaintenanceError}`));
    await expect(page.locator("[data-slot=result-error]")).toContainText(
      "could not reach the truth database",
    );
    await history.getByRole("button", { name: /^Show/ }).first().click();
    await expect(page.getByText("Expected sentence")).toBeVisible();
  });
});

test.describe("running a template", () => {
  test("runs to ok with the sentence, the rows, the duration and a new history entry", async ({
    page,
  }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);

    await runAndFinish(page);

    await expect(page).toHaveURL(/result_id=/);
    await expect(page.locator("[data-slot=sentence-text]")).toHaveText(
      "4 maintenance issues are open for gracie-demo on 2026-10-01; the newest is in room 412 (plumbing).",
    );
    const rows = page.getByRole("region", { name: "Rows returned by the query" });
    await expect(rows.getByRole("row")).toHaveCount(5);
    await expect(rows.getByRole("columnheader")).toHaveText([
      "#",
      "issue_id",
      "room",
      "category",
      "status",
      "opened_at",
      "assigned_to",
    ]);
    await expect(resultView(page)).toContainText("42 ms");
    await expect(page.getByRole("region", { name: "History" }).getByRole("listitem")).toHaveCount(
      3,
    );
  });

  test("shows pending first and turns ok after about two seconds for the slow template", async ({
    page,
  }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.slowOccupancy);
    const started = Date.now();

    await runQuery(page);

    await expect(page.locator("[data-slot=result-pending]")).toBeVisible();
    await expect(approveButton(page)).toBeDisabled();
    await expect(page.locator("[data-slot=sentence-text]")).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    await expect(page.locator("[data-slot=result-pending]")).toHaveCount(0);
    await expect(approveButton(page)).toBeEnabled();
  });

  test("stops polling once the result is final", async ({ page }) => {
    let polls = 0;
    page.on("request", (request) => {
      if (RESULT_REQUEST.test(request.url()) && request.method() === "GET") {
        polls += 1;
      }
    });
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);

    await runAndFinish(page);
    const atSettle = polls;
    await page.waitForTimeout(2600);

    expect(atSettle).toBeGreaterThanOrEqual(1);
    expect(polls).toBe(atSettle);
  });

  test("sends an Idempotency-Key and the typed parameters", async ({ page }) => {
    const sent: Array<{ key: string | undefined; body: unknown }> = [];
    await page.route(RUN_REQUEST, async (route) => {
      sent.push({
        key: route.request().headers()["idempotency-key"],
        body: route.request().postDataJSON(),
      });
      await route.continue();
    });
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);
    await page.getByLabel(/^Row limit/).fill("3");
    await page.getByRole("switch", { name: /^Include closed/ }).click();
    await page.getByRole("combobox", { name: /^Role/ }).click();
    await page.getByRole("option", { name: "manager" }).click();

    await runAndFinish(page);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[0]?.body).toEqual({
      params: {
        tenant_id: "gracie-demo",
        as_of: "2026-10-01",
        role: "manager",
        limit: 3,
        include_closed: true,
      },
    });
    await expect(
      page.getByRole("region", { name: "Rows returned by the query" }).getByRole("row"),
    ).toHaveCount(4);
  });

  test("shows a failing query as an error with its message and no approval", async ({ page }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.failingExport);

    await runAndFinish(page);

    await expect(page.locator("[data-slot=result-error]")).toContainText("statement timeout");
    await expect(resultView(page)).toContainText("10.0 s");
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(approveButton(page)).toBeDisabled();
    await expect(page.getByText(/The run on screen failed/)).toBeVisible();
  });

  test("fails every run while the oracle_error fault is on", async ({ page, request }) => {
    await setMockFaults(request, { oracle_error: true });
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);

    await runAndFinish(page);

    await expect(page.locator("[data-slot=result-error]")).toContainText(
      "The oracle worker could not reach the truth database",
    );
  });

  test("flags a cut result with a banner and 200 rows", async ({ page }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.guestRequestsExport);

    await runAndFinish(page);

    await expect(page.locator("[data-slot=rows-truncated]")).toContainText(
      "only the first 200 rows are stored and shown",
    );
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(201);
  });

  test("treats a query without rows as a valid result that can be approved", async ({ page }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.lateCheckouts);

    await runAndFinish(page);

    await expect(page.locator("[data-slot=rows-empty]")).toHaveText(
      "The query returned no rows. That is still a valid result.",
    );
    await expect(page.locator("[data-slot=sentence-text]")).toHaveText(
      "No late checkouts are expected for gracie-demo on 2026-10-01.",
    );
    await expect(approveButton(page)).toBeEnabled();
  });

  test("handles ragged and nested rows and expands long cells", async ({ page }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.staffRoster);

    await runAndFinish(page);

    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText([
      "#",
      "display_name",
      "shifts",
      "contact",
      "notes",
      "badge",
    ]);
    await expect(table).toContainText('{"phone":"555-0100","email":"maya.rossi@gracie.example"}');
    await expect(table.getByText("no value").first()).toBeAttached();
    await expect(table.getByText("null", { exact: true })).toBeVisible();
    const expand = table.getByRole("button", { name: /Show more of notes in row 3/ });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expand.click();
    await expect(
      table.getByRole("button", { name: /Show less of notes in row 3/ }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(table).toContainText("Prefers early shifts. Prefers early shifts.");
  });

  test("shows html-looking row values as text and runs no script", async ({ page }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);

    await runAndFinish(page);

    await expect(page.getByRole("table").getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    await expect(page.getByRole("table").locator("img")).toHaveCount(0);
  });

  test("blocks an invalid parameter in the browser without calling the API", async ({ page }) => {
    let posts = 0;
    await page.route(RUN_REQUEST, async (route) => {
      posts += 1;
      await route.continue();
    });
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);
    await page.getByLabel(/^Tenant/).fill("ab");
    await page.getByLabel(/^Row limit/).fill("500");

    await runQuery(page);

    await expect(page.getByText("Use at least 3 characters")).toBeVisible();
    await expect(page.getByText("Must be at most 200")).toBeVisible();
    await expect(page.getByLabel(/^Tenant/)).toHaveAttribute("aria-invalid", "true");
    expect(posts).toBe(0);
    await page.getByLabel(/^Tenant/).fill("abc");
    await page.getByLabel(/^Row limit/).fill("5");
    await expect(page.getByText("Use at least 3 characters")).toHaveCount(0);
  });

  test("maps a server 422 onto the parameter it names", async ({ page }) => {
    await page.route(RUN_REQUEST, async (route) => {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "validation_failed",
            message: "Request validation failed",
            request_id: "req-e2e-422",
            details: [
              {
                loc: ["body", "params", "tenant_id"],
                code: "unknown_tenant",
                message: "Tenant is not known to the truth database",
              },
            ],
          },
        }),
      });
    });
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);

    await runQuery(page);

    await expect(page.getByText("Tenant is not known to the truth database")).toBeVisible();
    await expect(page.getByLabel(/^Tenant/)).toHaveAttribute("aria-invalid", "true");
  });

  test("falls back to a JSON textarea with a notice for parameters outside the supported subset", async ({
    page,
  }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.escalationRules);

    await expect(page.getByRole("note")).toContainText("Edit as JSON");
    const textarea = page.getByRole("textbox", { name: "Parameters (JSON)" });
    await textarea.fill("{ not json");
    await runQuery(page);
    await expect(page.getByText(/^Not valid JSON/)).toBeVisible();
    await textarea.fill('{"tenant_id": "gracie-demo", "severities": ["high"]}');
    await runAndFinish(page);

    await expect(page.locator("[data-slot=sentence-text]")).toBeVisible();
  });
});

test.describe("approving a template", () => {
  test("keeps Approve and Reject disabled until an ok result is on screen, then approves", async ({
    page,
  }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);
    const approve = approveButton(page);
    const reject = rejectButton(page);

    await expect(approve).toBeDisabled();
    await expect(reject).toBeDisabled();
    await expect(
      page.getByText("Run the query and review its rows before you decide."),
    ).toBeVisible();

    await runAndFinish(page);
    await expect(approve).toBeEnabled();
    await expect(reject).toBeEnabled();
    await approve.click();

    await expect(page.getByText("open_maintenance is now approved.")).toBeVisible();
    await expect(detail(page).getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(templateButton(page, "open_maintenance")).toContainText("Approved");
    await expect(approve).toBeDisabled();

    await page.reload();
    await expect(approveButton(page)).toBeDisabled();
    await expect(templateButton(page, "open_maintenance")).toContainText("Approved");
  });

  test("rejects a template after reviewing a result", async ({ page }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.roomsInventory);

    await runAndFinish(page);
    await rejectButton(page).click();

    await expect(page.getByText("rooms_inventory is now rejected.")).toBeVisible();
    await expect(templateButton(page, "rooms_inventory")).toContainText("Rejected");
  });

  test("shows the server message and request id when the decision is refused", async ({ page }) => {
    await page.route(/\/approval$/, async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "conflict",
            message: "The template changed since the result was produced",
            request_id: "req-e2e-409",
            details: [],
          },
        }),
      });
    });
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);
    await runAndFinish(page);

    await approveButton(page).click();

    const alert = page.getByRole("main").getByRole("alert").filter({ hasText: "Could not save" });
    await expect(alert).toContainText("The template changed since the result was produced");
    await expect(alert).toContainText("Request ID: req-e2e-409");
  });
});

test.describe("oracle for a viewer", () => {
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

  test("can read results but cannot run or decide, and is told why", async ({ page }) => {
    await page.goto("/login");
    await signInThroughForm(page, {
      email: "viewer@tessa.local",
      password: "dev-only-viewer-password-1",
    });

    await openOracle(
      page,
      `?target_id=${gracie}&template_id=${ORACLE_TEMPLATE_IDS.openMaintenance}&result_id=${ORACLE_RESULT_IDS.openMaintenanceOk}`,
    );

    await expect(page.locator("[data-slot=sentence-text]")).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByRole("button", { name: "Run query" })).toBeDisabled();
    await expect(
      page.getByText("Your role is viewer, so you cannot run queries. A member can."),
    ).toBeVisible();
    await expect(page.getByLabel(/^Tenant/)).toBeDisabled();
    await expect(approveButton(page)).toBeDisabled();
    await expect(rejectButton(page)).toBeDisabled();
    await expect(
      page.getByText(/Your role is viewer, so you cannot approve or reject/),
    ).toBeVisible();
  });
});

test.describe("keyboard only", () => {
  test("selects a template, runs it and approves it without a pointer", async ({ page }) => {
    await openOracle(page);

    await tabUntil(page, templateButton(page, "open_maintenance"));
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 2, name: "open_maintenance" })).toBeVisible();

    await tabUntil(page, page.getByRole("button", { name: "Run query" }));
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-slot=sentence-text]")).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });

    await tabUntil(page, approveButton(page));
    await page.keyboard.press("Space");

    await expect(page.getByText("open_maintenance is now approved.")).toBeVisible();
  });

  test("fills the parameters from the keyboard and submits with Enter", async ({ page }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);
    const tenant = page.getByLabel(/^Tenant/);

    await tenant.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("hotel-two");
    await page.keyboard.press("Enter");

    await expect(page.locator("[data-slot=sentence-text]")).toContainText("hotel-two", {
      timeout: SETTLE_TIMEOUT_MS,
    });
  });

  test("opens the role list with the keyboard and picks an option", async ({ page }) => {
    await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);
    const role = page.getByRole("combobox", { name: /^Role/ });

    await role.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: "manager" }).focus();
    await page.keyboard.press("Enter");

    await expect(role).toContainText("manager");
  });
});

test.describe("hydration", () => {
  test("never leaves the page stuck after a reload", async ({ page }) => {
    test.setTimeout(HYDRATION_TEST_TIMEOUT_MS);
    for (let attempt = 0; attempt < RELOADS; attempt += 1) {
      await page.goto(
        `/oracle?target_id=${gracie}&template_id=${ORACLE_TEMPLATE_IDS.openMaintenance}&result_id=${ORACLE_RESULT_IDS.openMaintenanceOk}&approval=unreviewed`,
      );
      await expect(page.getByRole("button", { name: "Run query" })).toBeEnabled({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(approveButton(page)).toBeEnabled({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(page.getByLabel(/^Tenant/)).toBeEnabled();
      await expect(page.locator("[data-slot=sentence-text]")).toBeVisible();
      await expect(page.getByRole("button", { name: "Approval: 1 selected" })).toBeVisible();
    }
  });

  test("never leaves a viewer's controls enabled after a reload", async ({ browser }) => {
    test.setTimeout(HYDRATION_TEST_TIMEOUT_MS);
    const context = await browser.newContext({ storageState: SIGNED_OUT_STORAGE_STATE });
    const page = await context.newPage();
    await page.goto("/login");
    await signInThroughForm(page, {
      email: "viewer@tessa.local",
      password: "dev-only-viewer-password-1",
    });

    for (let attempt = 0; attempt < RELOADS; attempt += 1) {
      await page.goto(
        `/oracle?target_id=${gracie}&template_id=${ORACLE_TEMPLATE_IDS.openMaintenance}&result_id=${ORACLE_RESULT_IDS.openMaintenanceOk}`,
      );
      await expect(page.getByText(/Your role is viewer, so you cannot run queries/)).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(page.getByRole("button", { name: "Run query" })).toBeDisabled();
      await expect(approveButton(page)).toBeDisabled();
    }
    await context.close();
  });
});

const colorSchemes = ["light", "dark"] as const;
const RULES_THAT_CANNOT_PASS_WHILE_A_RADIX_SELECT_HIDES_THE_PAGE = ["aria-hidden-focus"];

async function expectTheme(page: Page, scheme: (typeof colorSchemes)[number]) {
  const html = page.locator("html");
  if (scheme === "dark") {
    await expect(html).toHaveClass(/\bdark\b/);
  } else {
    await expect(html).not.toHaveClass(/\bdark\b/);
  }
}

for (const scheme of colorSchemes) {
  test.describe(`axe on the oracle page in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("the template list with nothing selected", async ({ page }) => {
      await openOracle(page);
      await expectTheme(page, scheme);

      await expectNoAxeViolations(page);
    });

    test("a template with its source, parameters and an ok result", async ({ page }) => {
      await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);
      await expect(page.locator("[data-slot=code-view]")).toContainText("smart_log", {
        timeout: SETTLE_TIMEOUT_MS,
      });
      await runAndFinish(page);
      await expect(page.locator("[data-slot=sentence-text]")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("a pending result", async ({ page }) => {
      await openTemplate(page, ORACLE_TEMPLATE_IDS.slowOccupancy);
      await runQuery(page);
      await expect(page.locator("[data-slot=result-pending]")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("an error result", async ({ page }) => {
      await openTemplate(page, ORACLE_TEMPLATE_IDS.failingExport);
      await runAndFinish(page);
      await expect(page.locator("[data-slot=result-error]")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("a cut result and an empty result", async ({ page }) => {
      await openTemplate(page, ORACLE_TEMPLATE_IDS.guestRequestsExport);
      await runAndFinish(page);
      await expect(page.locator("[data-slot=rows-truncated]")).toBeVisible();
      await expectNoAxeViolations(page);

      await openTemplate(page, ORACLE_TEMPLATE_IDS.lateCheckouts);
      await runAndFinish(page);
      await expect(page.locator("[data-slot=rows-empty]")).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("ragged rows with an expanded cell", async ({ page }) => {
      await openTemplate(page, ORACLE_TEMPLATE_IDS.staffRoster);
      await runAndFinish(page);
      await page.getByRole("button", { name: /Show more of notes in row 3/ }).click();

      await expectNoAxeViolations(page);
    });

    test("an unverified template, parameter errors and the JSON fallback", async ({ page }) => {
      await openTemplate(page, ORACLE_TEMPLATE_IDS.rawSqlProbe);
      await expect(page.locator("[data-slot=read-only-warning]")).toBeVisible();
      await page.getByLabel(/^Tenant/).fill("");
      await runQuery(page);
      await expect(page.getByText("Required")).toBeVisible();
      await expectNoAxeViolations(page);

      await openTemplate(page, ORACLE_TEMPLATE_IDS.escalationRules);
      await expect(page.getByRole("note")).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("the open filter popover and the open role list", async ({ page }) => {
      await openTemplate(page, ORACLE_TEMPLATE_IDS.openMaintenance);
      await page.getByRole("button", { name: /^Approval: / }).click();
      await expect(page.getByRole("checkbox", { name: "Rejected", exact: true })).toBeVisible();
      await expectNoAxeViolations(page);
      await page.keyboard.press("Escape");

      await page.getByRole("combobox", { name: /^Role/ }).click();
      await expect(page.getByRole("option", { name: "manager" })).toBeVisible();
      await expectNoAxeViolations(page, {
        disableRules: RULES_THAT_CANNOT_PASS_WHILE_A_RADIX_SELECT_HIDES_THE_PAGE,
      });
    });

    test("no target, no templates, a missing template and a server error", async ({
      page,
      request,
    }) => {
      await page.goto("/oracle");
      await expect(page.getByRole("heading", { level: 2, name: "Choose a target" })).toBeVisible();
      await expectNoAxeViolations(page);

      await page.goto(`/oracle?target_id=${billing}`);
      await expect(page.getByRole("heading", { name: "No oracle templates" })).toBeVisible();
      await expectNoAxeViolations(page);

      await page.goto(
        `/oracle?target_id=${gracie}&template_id=0198f6f2-4c2a-7d10-9c1e-000000000000`,
      );
      await expect(page.getByRole("heading", { name: "Template not found" })).toBeVisible();
      await expectNoAxeViolations(page);

      await configureOracle(request, { seed: "empty" });
      await page.route(/\/api\/v1\/oracle-templates(\?|$)/, (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "internal_error", message: "Boom", request_id: "req-axe", details: [] },
          }),
        }),
      );
      await page.goto(`/oracle?target_id=${gracie}`);
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "Could not load the oracle templates",
      );
      await expectNoAxeViolations(page);
    });
  });
}
