import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../helpers/axe";
import { clearMockFaults, readMockState, resetMockApi, setMockFaults } from "../helpers/mock-api";

const FAST_TICKS = "3";
const FAST_INTERVAL_MS = "200";
const LONG_TICKS = "6";
const LONG_INTERVAL_MS = "400";
const FINISH_TIMEOUT_MS = 20_000;

const EXPECTED_PERSISTED_ORDER = [
  "run.created",
  "run.status_changed",
  "hello.tick",
  "hello.tick",
  "hello.tick",
  "hello.laya",
  "run.finished",
];

async function configureRun(page: Page, ticks: string, intervalMs: string) {
  await page.getByLabel("Ticks").fill(ticks);
  await page.getByLabel("Interval (ms)").fill(intervalMs);
}

async function startRun(page: Page) {
  const start = page.getByRole("button", { name: "Start hello run" });
  await expect(start).toBeEnabled();
  await start.click();
}

function phase(page: Page) {
  return page.getByTestId("hello-status");
}

async function listedEvents(page: Page) {
  return page
    .getByTestId("hello-events")
    .locator("li")
    .evaluateAll((items) =>
      items.map((item) => ({
        type: item.getAttribute("data-event-type") ?? "",
        seq: item.getAttribute("data-seq"),
      })),
    );
}

function persistedSeqs(events: Array<{ type: string; seq: string | null }>): number[] {
  return events.flatMap((event) => (event.seq === null ? [] : [Number(event.seq)]));
}

function expectConsecutiveFromOne(seqs: number[]) {
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
}

test.describe("/dev/hello", () => {
  test.beforeEach(async ({ request }) => {
    await resetMockApi(request);
  });

  test.afterEach(async ({ request }) => {
    await clearMockFaults(request);
  });

  test("starts a run and lists the events in the contract order", async ({ page }) => {
    await page.goto("/dev/hello");
    await expect(phase(page)).toHaveAttribute("data-phase", "idle");
    await configureRun(page, FAST_TICKS, FAST_INTERVAL_MS);

    await startRun(page);

    await expect(phase(page)).toHaveAttribute("data-phase", "finished", {
      timeout: FINISH_TIMEOUT_MS,
    });
    const events = await listedEvents(page);
    expect(events.filter((event) => event.seq !== null).map((event) => event.type)).toEqual(
      EXPECTED_PERSISTED_ORDER,
    );
    expectConsecutiveFromOne(persistedSeqs(events));
    expect(events.some((event) => event.type === "stream.heartbeat")).toBe(false);
    await expect(page).toHaveURL(/\/dev\/hello\?run_id=[0-9a-f-]{36}$/);
    await expect(page.getByTestId("hello-last-seq")).toHaveText("last seq 7");
  });

  test("shows hello.laya with ok true when Laya is included", async ({ page }) => {
    await page.goto("/dev/hello");
    await configureRun(page, "1", FAST_INTERVAL_MS);
    await startRun(page);

    await expect(phase(page)).toHaveAttribute("data-phase", "finished", {
      timeout: FINISH_TIMEOUT_MS,
    });
    await expect(page.getByText("Laya smoke call succeeded")).toBeVisible();
  });

  test("a closed stream with fault ws_close_4413 shows reconnecting, then resumes without a duplicate or a gap", async ({
    page,
    request,
  }) => {
    await page.goto("/dev/hello");
    await configureRun(page, LONG_TICKS, LONG_INTERVAL_MS);
    await startRun(page);
    await expect(phase(page)).toHaveAttribute("data-phase", "streaming");

    await setMockFaults(request, { ws_close_4413: true });

    await expect(phase(page)).toHaveAttribute("data-phase", "reconnecting", { timeout: 10_000 });
    await expect(page.getByRole("status").first()).toHaveAttribute("data-state", "reconnecting");
    await expect(phase(page)).toHaveAttribute("data-phase", "finished", {
      timeout: FINISH_TIMEOUT_MS,
    });

    const events = await listedEvents(page);
    const seqs = persistedSeqs(events);
    expectConsecutiveFromOne(seqs);
    expect(seqs).toHaveLength(10);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.at(-1)?.type).toBe("run.finished");
    const state = await readMockState(request);
    expect(state.connections.ticketsIssued).toBeGreaterThanOrEqual(2);
  });

  test("a skipped seq (fault ws_gap) is detected and repaired from the last good seq", async ({
    page,
    request,
  }) => {
    await page.goto("/dev/hello");
    await configureRun(page, LONG_TICKS, LONG_INTERVAL_MS);
    await startRun(page);
    await expect(phase(page)).toHaveAttribute("data-phase", "streaming");

    await setMockFaults(request, { ws_gap: true });

    await expect(phase(page)).toHaveAttribute("data-phase", "finished", {
      timeout: FINISH_TIMEOUT_MS,
    });
    const seqs = persistedSeqs(await listedEvents(page));
    expectConsecutiveFromOne(seqs);
    expect(seqs).toHaveLength(10);
  });

  test("a reload with ?run_id= loads the log first and resumes with no duplicate or gap", async ({
    page,
  }) => {
    await page.goto("/dev/hello");
    await configureRun(page, LONG_TICKS, LONG_INTERVAL_MS);
    await startRun(page);
    await expect(page.locator('[data-event-type="hello.tick"]').nth(1)).toBeVisible();
    const before = persistedSeqs(await listedEvents(page));

    await page.reload();

    await expect(phase(page)).toHaveAttribute("data-phase", "finished", {
      timeout: FINISH_TIMEOUT_MS,
    });
    const seqs = persistedSeqs(await listedEvents(page));
    expectConsecutiveFromOne(seqs);
    expect(seqs).toHaveLength(10);
    expect(seqs.length).toBeGreaterThan(before.length);
  });

  test("a reload of a finished run shows the same log and stays finished", async ({ page }) => {
    await page.goto("/dev/hello");
    await configureRun(page, FAST_TICKS, FAST_INTERVAL_MS);
    await startRun(page);
    await expect(phase(page)).toHaveAttribute("data-phase", "finished", {
      timeout: FINISH_TIMEOUT_MS,
    });
    const first = await listedEvents(page);

    await page.reload();

    await expect(phase(page)).toHaveAttribute("data-phase", "finished");
    const second = await listedEvents(page);
    expect(persistedSeqs(second)).toEqual(persistedSeqs(first));
    expect(second.filter((event) => event.seq !== null)).toHaveLength(7);
  });

  test("an unknown run in the URL shows a clear failure", async ({ page }) => {
    await page.goto("/dev/hello?run_id=0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e99");

    await expect(phase(page)).toHaveAttribute("data-phase", "failed");
    await expect(page.getByText("This run was not found")).toBeVisible();
  });

  test("names Temporal when the API answers 503 dependency_unavailable", async ({
    page,
    request,
  }) => {
    await setMockFaults(request, { hello_503: true });
    await page.goto("/dev/hello");

    await startRun(page);

    const alert = page.getByTestId("hello-unavailable");
    await expect(alert).toContainText("Temporal is not running");
    await expect(phase(page)).toHaveAttribute("data-phase", "unavailable");
    await expect(page).toHaveURL(/\/dev\/hello$/);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  });

  test("token_expired_once refreshes the API token silently and the run still starts", async ({
    page,
    request,
  }) => {
    const mints: string[] = [];
    page.on("request", (candidate) => {
      if (candidate.url().includes("/api/session/api-token")) {
        mints.push(candidate.url());
      }
    });
    await setMockFaults(request, { token_expired_once: true });

    await page.goto("/dev/hello");
    await configureRun(page, FAST_TICKS, FAST_INTERVAL_MS);
    await startRun(page);

    await expect(phase(page)).toHaveAttribute("data-phase", "finished", {
      timeout: FINISH_TIMEOUT_MS,
    });
    expect(mints.length).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("hello-failed")).toHaveCount(0);
    await expect(page.getByTestId("hello-unavailable")).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/login/);
    const state = await readMockState(request);
    expect(state.faults.token_expired_once).toBe(0);
  });

  test.describe("accessibility", () => {
    test("has no axe violations when idle", async ({ page }) => {
      await page.goto("/dev/hello");
      await expect(phase(page)).toHaveAttribute("data-phase", "idle");

      await expectNoAxeViolations(page);
    });

    test("has no axe violations while streaming and when finished", async ({ page }) => {
      await page.goto("/dev/hello");
      await configureRun(page, LONG_TICKS, LONG_INTERVAL_MS);
      await startRun(page);
      await expect(phase(page)).toHaveAttribute("data-phase", "streaming");
      await expectNoAxeViolations(page);

      await expect(phase(page)).toHaveAttribute("data-phase", "finished", {
        timeout: FINISH_TIMEOUT_MS,
      });
      await expectNoAxeViolations(page);
    });

    test("has no axe violations in the 503 state", async ({ page, request }) => {
      await setMockFaults(request, { hello_503: true });
      await page.goto("/dev/hello");
      await startRun(page);
      await expect(page.getByTestId("hello-unavailable")).toBeVisible();

      await expectNoAxeViolations(page);
    });
  });
});
