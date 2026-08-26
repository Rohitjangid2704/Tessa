import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STAGE_TWO_IDS } from "../../../mocks/stage2/seed-ids";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { expectNoAxeViolations } from "../helpers/axe";
import { apiOrigin } from "../helpers/env";
import { signInThroughForm } from "../helpers/login";
import { clearMockFaults, readMockState, resetMockApi, setMockFaults } from "../helpers/mock-api";

const RELOADS = 12;
const SETTLE_TIMEOUT_MS = 15_000;
const FINISH_TIMEOUT_MS = 40_000;
const HYDRATION_TEST_TIMEOUT_MS = 120_000;
const RUN_SPEED = 2;
const FAILED_RESOURCE_LOG = "Failed to load resource";
const UNKNOWN_RUN_ID = "0198f6f2-0000-7000-8000-00000000dead";
const VIEWER = { email: "viewer@tessa.local", password: "dev-only-viewer-password-1" };
const colorSchemes = ["light", "dark"] as const;

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
  await control(request, "seed", { seed: "gracie" });
  await control(request, "clock", { speed: RUN_SPEED });
});

test.afterEach(async ({ request }) => {
  await clearMockFaults(request);
  await control(request, "release", {});
  await control(request, "clock", { speed: 1, paused: false });
  expect(pageErrors).toEqual([]);
});

async function control(request: APIRequestContext, name: string, data: object): Promise<void> {
  const response = await request.post(`${apiOrigin()}/__mock/stage2/${name}`, { data });
  expect(response.ok(), `mock control ${name}`).toBe(true);
}

async function stageTwoRuns(request: APIRequestContext) {
  const response = await request.get(`${apiOrigin()}/__mock/stage2/state`);
  const body = (await response.json()) as {
    runs: Array<{ run_id: string; status: string; terminal: boolean; events: number }>;
  };
  return body.runs;
}

async function startRun(page: Page): Promise<string> {
  const tokenResponse = await page.request.get("/api/session/api-token");
  const { token } = (await tokenResponse.json()) as { token: string };
  const response = await page.request.post(`${apiOrigin()}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
    data: { plan_id: STAGE_TWO_IDS.plans.smartLog },
  });
  expect(response.status(), await response.text()).toBe(202);
  return ((await response.json()) as { run_id: string }).run_id;
}

function runUrl(runId: string): string {
  return `/runs/${runId}`;
}

function header(page: Page) {
  return page.locator('[data-slot="run-header"]');
}

function liveChip(page: Page) {
  return header(page).locator('[data-slot="live-indicator"]');
}

function statusText(page: Page, label: string) {
  return header(page).getByText(label, { exact: true }).first();
}

function progressText(page: Page) {
  return header(page).locator('[data-slot="verdict-progress"]');
}

function cancelButton(page: Page) {
  return page.getByRole("button", { name: "Cancel run" });
}

function captureSocketTraffic(page: Page) {
  const seqs: number[] = [];
  const sockets: string[] = [];
  page.on("websocket", (socket) => {
    sockets.push(socket.url());
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") {
        return;
      }
      const message = JSON.parse(payload) as { seq: number | null };
      if (message.seq !== null) {
        seqs.push(message.seq);
      }
    });
  });
  return { seqs, sockets };
}

function expectConsecutive(seqs: number[]) {
  for (let index = 1; index < seqs.length; index += 1) {
    expect(seqs[index], `seq at ${index}`).toBe((seqs[index - 1] ?? 0) + 1);
  }
}

test.describe("watching a live run", () => {
  test("queued first, then running, counters advance, then a terminal state without a socket", async ({
    page,
    request,
  }) => {
    await control(request, "hold", { phase: "created" });
    const runId = await startRun(page);

    await page.goto(runUrl(runId));

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Suite run");
    await expect(statusText(page, "Queued")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(page.getByRole("region", { name: "Live tiles" })).toContainText("No tiles yet");
    await expect(liveChip(page)).toHaveAttribute("data-state", "live", {
      timeout: SETTLE_TIMEOUT_MS,
    });
    await expect(cancelButton(page)).toBeVisible();

    await control(request, "release", { phase: "created" });

    await expect(statusText(page, "Running")).toBeVisible({ timeout: FINISH_TIMEOUT_MS });
    await expect(progressText(page)).not.toHaveText(/^0 of 0 /);
    await expect
      .poll(async () => (await progressText(page).textContent()) ?? "", {
        timeout: FINISH_TIMEOUT_MS,
      })
      .toMatch(/^[1-9]\d* of \d+ scenarios done$/);

    await expect(statusText(page, "Completed")).toBeVisible({ timeout: FINISH_TIMEOUT_MS });
    await expect(liveChip(page)).toHaveText("Not live");
    await expect(cancelButton(page)).toHaveCount(0);
    await expect.poll(async () => (await readMockState(request)).connections.open).toBe(0);
    await expect(page.getByRole("group", { name: "Connection" })).toHaveCount(0);
  });

  test("a closed stream with fault ws_close_4413 reconnects and resumes with no duplicate or missing seq", async ({
    page,
    request,
  }) => {
    const traffic = captureSocketTraffic(page);
    await control(request, "hold", { phase: "running" });
    const runId = await startRun(page);
    await page.goto(runUrl(runId));
    await expect(liveChip(page)).toHaveAttribute("data-state", "live", {
      timeout: SETTLE_TIMEOUT_MS,
    });
    await expect(statusText(page, "Running")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });

    await setMockFaults(request, { ws_close_4413: true });
    await control(request, "release", { phase: "running" });

    await expect(page.getByRole("group", { name: "Connection" })).toContainText(
      "Reconnecting to the live stream",
      { timeout: SETTLE_TIMEOUT_MS },
    );
    await expect(statusText(page, "Completed")).toBeVisible({ timeout: FINISH_TIMEOUT_MS });
    await expect(page.getByRole("group", { name: "Connection" })).toHaveCount(0);

    expect(traffic.sockets.length).toBeGreaterThanOrEqual(2);
    expect(traffic.seqs.length).toBeGreaterThan(5);
    expectConsecutive(traffic.seqs);
    expect(new Set(traffic.seqs).size).toBe(traffic.seqs.length);
    const runs = await stageTwoRuns(request);
    expect(traffic.seqs.at(-1)).toBe(runs.find((run) => run.run_id === runId)?.events);
    const state = await readMockState(request);
    expect(state.connections.ticketsIssued).toBeGreaterThanOrEqual(2);
    expect(state.connections.open).toBe(0);
  });

  test("a stream that skips a seq (fault ws_gap) reconnects and the log stays gap free", async ({
    page,
    request,
  }) => {
    const traffic = captureSocketTraffic(page);
    await control(request, "hold", { phase: "running" });
    const runId = await startRun(page);
    await page.goto(runUrl(runId));
    await expect(liveChip(page)).toHaveAttribute("data-state", "live", {
      timeout: SETTLE_TIMEOUT_MS,
    });

    await setMockFaults(request, { ws_gap: true });
    await control(request, "release", { phase: "running" });

    await expect(statusText(page, "Completed")).toBeVisible({ timeout: FINISH_TIMEOUT_MS });
    expect(traffic.sockets.length).toBeGreaterThanOrEqual(2);
    const runs = await stageTwoRuns(request);
    const total = runs.find((run) => run.run_id === runId)?.events ?? 0;
    const distinct = [...new Set(traffic.seqs)].sort((left, right) => left - right);
    expect(distinct.at(-1)).toBe(total);
    expectConsecutive(distinct);
    await expect(progressText(page)).toBeVisible();
  });

  test("reloading in the middle of a run keeps working and reaches the end", async ({
    page,
    request,
  }) => {
    await control(request, "hold", { phase: "first_step" });
    const runId = await startRun(page);
    await page.goto(runUrl(runId));
    await expect(statusText(page, "Running")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });

    await page.reload();

    await expect(statusText(page, "Running")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(liveChip(page)).toHaveAttribute("data-state", "live", {
      timeout: SETTLE_TIMEOUT_MS,
    });
    await control(request, "release", { phase: "first_step" });
    await expect(statusText(page, "Completed")).toBeVisible({ timeout: FINISH_TIMEOUT_MS });
    await expect(liveChip(page)).toHaveText("Not live");
  });
});

test.describe("cancel", () => {
  test("asks for confirmation, then shows canceling and ends canceled", async ({
    page,
    request,
  }) => {
    await control(request, "hold", { phase: "first_step" });
    const runId = await startRun(page);
    await page.goto(runUrl(runId));
    await expect(statusText(page, "Running")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });

    await cancelButton(page).click();
    const dialog = page.getByRole("alertdialog", { name: "Cancel this run?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep running" }).click();
    await expect(dialog).toBeHidden();
    await expect(statusText(page, "Running")).toBeVisible();

    await cancelButton(page).click();
    await dialog.getByRole("button", { name: "Cancel run" }).click();

    await expect(page.getByRole("group", { name: "Cancellation" })).toContainText(
      "Cancel requested",
    );
    await expect(page.getByRole("button", { name: "Canceling" })).toBeDisabled();
    await expect(statusText(page, "Canceled")).toBeVisible({ timeout: FINISH_TIMEOUT_MS });
    await expect(cancelButton(page)).toHaveCount(0);
    await expect(liveChip(page)).toHaveText("Not live");
  });

  test("can be done with the keyboard alone", async ({ page, request }) => {
    await control(request, "hold", { phase: "first_step" });
    const runId = await startRun(page);
    await page.goto(runUrl(runId));
    await expect(statusText(page, "Running")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });

    await cancelButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Cancel run" }).last()).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(statusText(page, "Canceled")).toBeVisible({ timeout: FINISH_TIMEOUT_MS });
  });

  test("a viewer has no Cancel button but can read everything", async ({ page, request }) => {
    await control(request, "hold", { phase: "first_step" });
    const runId = await startRun(page);
    await page.context().clearCookies();
    await page.goto("/login");
    await signInThroughForm(page, VIEWER);

    await page.goto(runUrl(runId));

    await expect(statusText(page, "Running")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(page.getByRole("button", { name: "Config snapshot" })).toBeVisible();
    await expect(cancelButton(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^cancel/i })).toHaveCount(0);
  });
});

test.describe("terminal and special runs", () => {
  test("a finished run opens no socket and shows its final counters", async ({ page, request }) => {
    const before = (await readMockState(request)).connections.opened;

    await page.goto(runUrl(STAGE_TWO_IDS.runs.completed));

    await expect(statusText(page, "Completed")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(liveChip(page)).toHaveText("Not live");
    await expect(progressText(page)).toHaveText(/^\d+ of \d+ scenarios done$/);
    await expect(page.getByRole("link", { name: /open in temporal/i })).toBeVisible();
    await page.waitForTimeout(1500);
    const after = await readMockState(request);
    expect(after.connections.opened).toBe(before);
    expect(after.connections.open).toBe(0);
    await expect(cancelButton(page)).toHaveCount(0);
  });

  test("a budget_exceeded run shows the budget banner", async ({ page }) => {
    await page.goto(runUrl(STAGE_TWO_IDS.runs.budgetExceeded));

    await expect(page.getByRole("group", { name: "Budget" })).toContainText("Budget exceeded", {
      timeout: SETTLE_TIMEOUT_MS,
    });
    await expect(statusText(page, "Budget exceeded")).toBeVisible();
  });

  test("a run of a production target is marked read-only", async ({ page, request }) => {
    await control(request, "production-target", { allow_production: true });
    const runs = await stageTwoRuns(request);
    const production = runs.find((run) => run.run_id === STAGE_TWO_IDS.runs.production);
    expect(production).toBeDefined();

    await page.goto(runUrl(STAGE_TWO_IDS.runs.production));

    await expect(header(page).getByText("Read-only", { exact: true })).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });
  });

  test("an unknown run shows the not found error with a way back", async ({ page }) => {
    await page.goto(runUrl(UNKNOWN_RUN_ID));

    const alert = page.getByRole("alert").filter({ hasText: "Run not found" });
    await expect(alert).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(alert.getByRole("link", { name: "Back to runs" })).toHaveAttribute(
      "href",
      "/runs",
    );
  });

  test("the config snapshot opens as JSON and closes with Escape", async ({ page }) => {
    await page.goto(runUrl(STAGE_TWO_IDS.runs.completed));
    const open = page.getByRole("button", { name: "Config snapshot" });
    await expect(open).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });

    await open.click();

    const json = page.getByLabel("Config snapshot JSON");
    await expect(json).toBeVisible();
    expect(JSON.parse((await json.textContent()) ?? "{}")).toHaveProperty("bundle_hash");
    await page.keyboard.press("Escape");
    await expect(json).toBeHidden();
    await expect(open).toBeFocused();
  });
});

test.describe("layout", () => {
  test("stacks the three sections on a wide screen and switches to tabs below 900 px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(runUrl(STAGE_TWO_IDS.runs.completed));
    await expect(page.getByRole("region", { name: "Event log" })).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Live tiles" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Scenarios" })).toBeVisible();

    await page.setViewportSize({ width: 800, height: 900 });

    const tabs = page.getByRole("tablist", { name: "Run sections" });
    await expect(tabs).toBeVisible();
    await expect(page.getByRole("region", { name: "Event log" })).toBeHidden();
    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByRole("region", { name: "Event log" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Live tiles" })).toBeHidden();
  });
});

test.describe("hydration", () => {
  test.setTimeout(HYDRATION_TEST_TIMEOUT_MS);

  test("never leaves a finished run stuck after 12 reloads", async ({ page }) => {
    for (let attempt = 0; attempt < RELOADS; attempt += 1) {
      await page.goto(runUrl(STAGE_TWO_IDS.runs.completed));
      await expect(statusText(page, "Completed")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
      await expect(page.getByRole("button", { name: "Config snapshot" })).toBeEnabled();
      await expect(page.getByRole("region", { name: "Event log" })).toBeVisible();
    }
  });

  test("never leaves a running run stuck after 12 reloads and ends with one open socket", async ({
    page,
    request,
  }) => {
    await control(request, "hold", { phase: "first_step" });
    const runId = await startRun(page);
    for (let attempt = 0; attempt < RELOADS; attempt += 1) {
      await page.goto(runUrl(runId));
      await expect(statusText(page, "Running")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
      await expect(cancelButton(page)).toBeEnabled({ timeout: SETTLE_TIMEOUT_MS });
      await expect(liveChip(page)).toHaveAttribute("data-state", "live", {
        timeout: SETTLE_TIMEOUT_MS,
      });
    }
    await expect.poll(async () => (await readMockState(request)).connections.open).toBe(1);
  });
});

for (const scheme of colorSchemes) {
  test.describe(`axe in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("a running run, its cancel dialog and its config snapshot", async ({ page, request }) => {
      await control(request, "hold", { phase: "first_step" });
      const runId = await startRun(page);
      await page.goto(runUrl(runId));
      await expect(statusText(page, "Running")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
      await expect(liveChip(page)).toHaveAttribute("data-state", "live", {
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expectNoAxeViolations(page);

      await cancelButton(page).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await expectNoAxeViolations(page);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Config snapshot" }).click();
      await expect(page.getByRole("dialog", { name: "Config snapshot" })).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("a finished run, a budget exceeded run and the not found state", async ({ page }) => {
      await page.goto(runUrl(STAGE_TWO_IDS.runs.completed));
      await expect(statusText(page, "Completed")).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
      await expectNoAxeViolations(page);

      await page.goto(runUrl(STAGE_TWO_IDS.runs.budgetExceeded));
      await expect(page.getByRole("group", { name: "Budget" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expectNoAxeViolations(page);

      await page.goto(runUrl(UNKNOWN_RUN_ID));
      await expect(page.getByRole("alert").filter({ hasText: "Run not found" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expectNoAxeViolations(page);
    });

    test("the reconnecting banner and the narrow tabs layout", async ({ page, request }) => {
      await page.setViewportSize({ width: 800, height: 900 });
      await control(request, "hold", { phase: "running" });
      const runId = await startRun(page);
      await page.goto(runUrl(runId));
      await expect(liveChip(page)).toHaveAttribute("data-state", "live", {
        timeout: SETTLE_TIMEOUT_MS,
      });
      await setMockFaults(request, { ws_close_4413: true });
      await control(request, "release", { phase: "running" });
      await expect(page.getByRole("group", { name: "Connection" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });

      await expectNoAxeViolations(page);
    });
  });
}

test("a signed out user is sent to login", async ({ browser }) => {
  const context = await browser.newContext({ storageState: SIGNED_OUT_STORAGE_STATE });
  const page = await context.newPage();

  await page.goto(runUrl(STAGE_TWO_IDS.runs.completed));

  await expect(page).toHaveURL(/\/login/);
  await context.close();
});
