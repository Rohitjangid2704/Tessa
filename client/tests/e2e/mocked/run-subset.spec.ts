import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STAGE_ONE_IDS } from "../../../mocks/stage1/seed";
import { STAGE_TWO_IDS } from "../../../mocks/stage2/seed-ids";
import { apiOrigin } from "../helpers/env";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const pageErrors: string[] = [];

test.beforeEach(async ({ page, request }) => {
  pageErrors.length = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await resetMockApi(request);
  await control(request, "seed", { seed: "gracie" });
  await control(request, "clock", { speed: 100 });
});

test.afterEach(async ({ request }) => {
  await clearMockFaults(request);
  await control(request, "clock", { speed: 1, paused: false });
  expect(pageErrors).toEqual([]);
});

async function control(request: APIRequestContext, name: string, data: object): Promise<void> {
  const response = await request.post(`${apiOrigin()}/__mock/stage2/${name}`, { data });
  expect(response.ok(), `mock control ${name}`).toBe(true);
}

async function sessionToken(page: Page): Promise<string> {
  const response = await page.request.get("/api/session/api-token");
  return ((await response.json()) as { token: string }).token;
}

async function postRun(
  page: Page,
  token: string,
  data: Record<string, unknown>,
): Promise<{ status: number; runId: string }> {
  const response = await page.request.post(`${apiOrigin()}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
    data,
  });
  const body = (await response.json()) as { run_id?: string };
  return { status: response.status(), runId: body.run_id ?? "" };
}

async function mintPersonalToken(page: Page): Promise<string> {
  const response = await page.request.post(`${apiOrigin()}/api/v1/users/me/tokens`, {
    headers: { Authorization: `Bearer ${await sessionToken(page)}` },
    data: { name: "subset spec" },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

async function acceptedScenarioId(page: Page, token: string): Promise<string> {
  const fullRun = await postRun(page, token, { plan_id: STAGE_TWO_IDS.plans.smartLog });
  expect(fullRun.status).toBe(202);
  const response = await page.request.get(
    `${apiOrigin()}/api/v1/scenarios?target_id=${STAGE_ONE_IDS.gracie}&limit=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const page_ = (await response.json()) as { items: Array<{ id: string; status: string }> };
  const accepted = page_.items.find((item) => item.status === "accepted");
  expect(accepted).toBeDefined();
  return (accepted as { id: string }).id;
}

function header(page: Page) {
  return page.locator('[data-slot="run-header"]');
}

test.describe("subset runs from Claude Code", () => {
  test("labels the run with the agent chip and the subset badge", async ({ page }) => {
    await page.goto("/");
    const sessionJwt = await sessionToken(page);
    const scenarioId = await acceptedScenarioId(page, sessionJwt);
    const personal = await mintPersonalToken(page);

    const subset = await postRun(page, personal, {
      target_id: STAGE_ONE_IDS.gracie,
      scenario_ids: [scenarioId],
    });
    expect(subset.status).toBe(202);

    await page.goto(`/runs/${subset.runId}`);
    await expect(header(page).getByText("From Claude Code")).toBeVisible();
    await expect(header(page).getByText("Subset: 1 scenario")).toBeVisible();
    await expect(header(page).getByText("Invariants and API fuzz skipped")).toBeVisible();
  });

  test("shows neither label on a full run started from the web app", async ({ page }) => {
    await page.goto("/");
    const sessionJwt = await sessionToken(page);
    const full = await postRun(page, sessionJwt, { plan_id: STAGE_TWO_IDS.plans.smartLog });
    expect(full.status).toBe(202);

    await page.goto(`/runs/${full.runId}`);
    await expect(header(page)).toBeVisible();
    await expect(header(page).getByText("From Claude Code")).toHaveCount(0);
    await expect(page.locator('[data-slot="run-subset"]')).toHaveCount(0);
  });

  test("refuses a scenario that is not runnable with scenarios_not_runnable", async ({ page }) => {
    await page.goto("/");
    const sessionJwt = await sessionToken(page);
    const scenarioId = await acceptedScenarioId(page, sessionJwt);
    await page.request.post(`${apiOrigin()}/__mock/stage11/seed`, {
      data: { variants: { runs: "not_runnable" } },
    });

    const response = await page.request.post(`${apiOrigin()}/api/v1/runs`, {
      headers: { Authorization: `Bearer ${sessionJwt}`, "Idempotency-Key": crypto.randomUUID() },
      data: { target_id: STAGE_ONE_IDS.gracie, scenario_ids: [scenarioId] },
    });
    expect(response.status()).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("scenarios_not_runnable");
  });
});
