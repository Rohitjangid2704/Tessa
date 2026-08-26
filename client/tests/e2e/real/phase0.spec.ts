import { expect, test, type Page } from "@playwright/test";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { expectNoAxeViolations } from "../helpers/axe";
import { apiOrigin, readE2eCredentials } from "../helpers/env";
import { signInThroughForm } from "../helpers/login";

const NAV_LABELS = [
  "Targets",
  "Catalog",
  "Scenarios",
  "Runs",
  "Findings",
  "Labels",
  "Explore",
  "Settings",
];

const HELLO_TICKS = 5;
const HELLO_INTERVAL_MS = 300;
const HELLO_FINISH_TIMEOUT_MS = 30_000;

const EXPECTED_HELLO_ORDER = [
  "run.created",
  "run.status_changed",
  ...Array.from({ length: HELLO_TICKS }, () => "hello.tick"),
  "hello.laya",
  "run.finished",
];

interface ListedEvent {
  type: string;
  seq: number | null;
}

interface LoggedEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

async function listedEvents(page: Page): Promise<ListedEvent[]> {
  return page
    .getByTestId("hello-events")
    .locator("li")
    .evaluateAll((items) =>
      items.map((item) => {
        const seq = item.getAttribute("data-seq");
        return {
          type: item.getAttribute("data-event-type") ?? "",
          seq: seq === null ? null : Number(seq),
        };
      }),
    );
}

async function persistedEvents(page: Page): Promise<ListedEvent[]> {
  return (await listedEvents(page)).filter((event) => event.seq !== null);
}

async function mintApiToken(page: Page): Promise<string> {
  const response = await page.request.get("/api/session/api-token");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { token: string; expires_at: string };
  return body.token;
}

async function readRunLog(page: Page, runId: string): Promise<LoggedEvent[]> {
  const token = await mintApiToken(page);
  const response = await page.request.get(`${apiOrigin()}/api/v1/runs/${runId}/events?limit=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: LoggedEvent[]; head_seq: number };
  return body.items;
}

test.describe("signed out", () => {
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

  test("redirects / to the login page, then signs the bootstrap admin in", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();

    await signInThroughForm(page, readE2eCredentials());

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  });

  test("redirects a deep link to the login page keeping the callback URL", async ({ page }) => {
    await page.goto("/runs");

    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fruns$/);

    await signInThroughForm(page, readE2eCredentials());

    await expect(page).toHaveURL(/\/runs$/);
    await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
  });

  test("the minted token route refuses a visitor without a session", async ({ page }) => {
    const response = await page.request.get("/api/session/api-token");

    expect(response.status()).toBe(401);
  });
});

test.describe("signed in", () => {
  test("shows the eight sidebar items and each page renders", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link")).toHaveText(NAV_LABELS);

    for (const label of NAV_LABELS) {
      await nav.getByRole("link", { name: label }).click();

      await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
      await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
      await expect(page).not.toHaveURL(/\/login/);
    }
  });

  test("the minted API token is accepted by the API, directly and from the browser", async ({
    page,
  }) => {
    await page.goto("/");
    const token = await mintApiToken(page);
    const credentials = readE2eCredentials();

    const direct = await page.request.get(`${apiOrigin()}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(direct.status()).toBe(200);
    expect(await direct.json()).toMatchObject({ email: credentials.email, role: "admin" });

    const fromBrowser = await page.evaluate(
      async ({ origin, bearer }) => {
        const response = await fetch(`${origin}/api/v1/users/me`, {
          headers: { Authorization: `Bearer ${bearer}` },
        });
        return { status: response.status, body: (await response.json()) as { email: string } };
      },
      { origin: apiOrigin(), bearer: token },
    );
    expect(fromBrowser.status).toBe(200);
    expect(fromBrowser.body.email).toBe(credentials.email);

    const tampered = await page.request.get(`${apiOrigin()}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${token.slice(0, -4)}AAAA` },
    });
    expect(tampered.status()).toBe(401);
  });

  test("a hello run with Laya streams every event in order with contiguous seq", async ({
    page,
  }) => {
    await page.goto("/dev/hello");
    await page.getByLabel("Ticks").fill(String(HELLO_TICKS));
    await page.getByLabel("Interval (ms)").fill(String(HELLO_INTERVAL_MS));
    await expect(page.getByRole("switch", { name: "Include Laya" })).toBeChecked();

    await page.getByRole("button", { name: "Start hello run" }).click();

    await expect(page.getByTestId("hello-status")).toHaveAttribute("data-phase", "finished", {
      timeout: HELLO_FINISH_TIMEOUT_MS,
    });
    const persisted = await persistedEvents(page);
    expect(persisted.map((event) => event.type)).toEqual(EXPECTED_HELLO_ORDER);
    expect(persisted.map((event) => event.seq)).toEqual(
      Array.from({ length: EXPECTED_HELLO_ORDER.length }, (_, index) => index + 1),
    );
    await expect(page.getByText("Laya smoke call succeeded")).toBeVisible();
    await expect(page.getByTestId("hello-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("hello-failed")).toHaveCount(0);

    await expect(page).toHaveURL(/\/dev\/hello\?run_id=[0-9a-f-]{36}$/);
    const runId = new URL(page.url()).searchParams.get("run_id") ?? "";
    const log = await readRunLog(page, runId);
    expect(log.map((event) => event.type)).toEqual(EXPECTED_HELLO_ORDER);
    expect(log.map((event) => event.seq)).toEqual(persisted.map((event) => event.seq));
    const laya = log.find((event) => event.type === "hello.laya");
    expect(laya?.payload.ok).toBe(true);
    const finished = log.find((event) => event.type === "run.finished");
    expect(finished?.payload.status).toBe("completed");
  });

  test("a reload of the finished run shows the same log from the API", async ({ page }) => {
    await page.goto("/dev/hello");
    await page.getByLabel("Ticks").fill("2");
    await page.getByLabel("Interval (ms)").fill(String(HELLO_INTERVAL_MS));
    await page.getByRole("button", { name: "Start hello run" }).click();
    await expect(page.getByTestId("hello-status")).toHaveAttribute("data-phase", "finished", {
      timeout: HELLO_FINISH_TIMEOUT_MS,
    });
    const before = await persistedEvents(page);
    expect(before.map((event) => event.type)).toEqual([
      "run.created",
      "run.status_changed",
      "hello.tick",
      "hello.tick",
      "hello.laya",
      "run.finished",
    ]);

    await page.reload();

    await expect(page.getByTestId("hello-status")).toHaveAttribute("data-phase", "finished");
    expect(await persistedEvents(page)).toEqual(before);
  });

  test("settings lists bundle.v1.json and reports the database, Temporal and Laya up", async ({
    page,
  }) => {
    await page.goto("/settings");

    await expect(page.getByText("The API is responding.")).toBeVisible();
    const dependencies = page.getByRole("region", { name: "Dependencies" });
    await expect(dependencies.getByRole("row", { name: /Database/ })).toContainText("Up");
    await expect(dependencies.getByRole("row", { name: /Temporal/ })).toContainText("Up");
    await expect(dependencies.getByRole("row", { name: /Laya/ })).toContainText("Up");
    await expect(dependencies.getByRole("alert")).toHaveCount(0);

    const bundleLink = page.getByRole("link", { name: "bundle.v1.json" });
    await expect(bundleLink).toBeVisible();
    const href = await bundleLink.getAttribute("href");
    expect(href).toBe(`${apiOrigin()}/schemas/bundle.v1.json`);
    const schema = await page.request.get(href ?? "");
    expect(schema.status()).toBe(200);
    expect(schema.headers()["content-type"]).toContain("application/schema+json");
    expect(((await schema.json()) as { $id: string }).$id).toBe(href);
    await expectNoAxeViolations(page);
  });

  test("the finished hello run page has no axe violations", async ({ page }) => {
    await page.goto("/dev/hello");
    await page.getByLabel("Ticks").fill("1");
    await page.getByLabel("Interval (ms)").fill(String(HELLO_INTERVAL_MS));
    await page.getByRole("button", { name: "Start hello run" }).click();
    await expect(page.getByTestId("hello-status")).toHaveAttribute("data-phase", "finished", {
      timeout: HELLO_FINISH_TIMEOUT_MS,
    });

    await expectNoAxeViolations(page);
  });
});
