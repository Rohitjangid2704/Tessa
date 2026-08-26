import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { readE2eCredentials } from "../helpers/env";
import { signInThroughForm } from "../helpers/login";
import { apiRequest, uploadBundleFile } from "./support/api";
import { buildBundleFixtures, ensureViewerUser } from "./support/fixtures";
import { VIEWER_CREDENTIALS } from "./support/stack";

const RELOADS = 15;
const SETTLE_TIMEOUT_MS = 10_000;
const ROUTE_TIMEOUT_MS = 240_000;
const FAILED_RESOURCE_LOG = "Failed to load resource";
const FIXTURE_DIRECTORY = path.join("test-results", "fixtures", "hydration-sweep");

const target = { id: "", token: "", zip: "" };

interface Route {
  name: string;
  url: () => string;
  admin: (page: Page) => Promise<void>;
  viewer: (page: Page) => Promise<void>;
}

function watchConsole(page: Page): () => string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (
      (message.type() === "error" || message.type() === "warning") &&
      !text.startsWith(FAILED_RESOURCE_LOG)
    ) {
      problems.push(`${message.type()}: ${text}`);
    }
  });
  return () => problems;
}

async function expectEnabled(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
  await expect(locator).toBeEnabled({ timeout: SETTLE_TIMEOUT_MS });
}

async function expectDisabled(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
  await expect(locator).toBeDisabled({ timeout: SETTLE_TIMEOUT_MS });
}

async function expectAbsent(locator: Locator): Promise<void> {
  await expect(locator).toHaveCount(0, { timeout: SETTLE_TIMEOUT_MS });
}

const environmentField = (page: Page) =>
  page.locator('[data-variable="GRACIE_BASE_URL"]').getByLabel("GRACIE_BASE_URL", { exact: true });

const ROUTES: Route[] = [
  {
    name: "/",
    url: () => "/",
    admin: async (page) => {
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    },
    viewer: async (page) => {
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    name: "/targets",
    url: () => "/targets",
    admin: async (page) => {
      await expect(page.getByRole("link", { name: "New target" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(page.getByRole("link", { name: "Hydration Sweep" }).first()).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
    },
    viewer: async (page) => {
      await expect(page.getByRole("link", { name: "Hydration Sweep" }).first()).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expectAbsent(page.getByRole("link", { name: "New target" }));
    },
  },
  {
    name: "/targets/[id]",
    url: () => `/targets/${target.id}`,
    admin: async (page) => {
      await expectEnabled(page.getByRole("button", { name: "Generate Discovery prompt" }));
      await expectEnabled(page.getByRole("button", { name: "Rotate token" }));
      await expectEnabled(page.getByRole("button", { name: "Archive target" }));
      await expectEnabled(
        page.locator("[data-slot=target-settings-card]").getByLabel("Name", { exact: true }),
      );
    },
    viewer: async (page) => {
      await expectDisabled(page.getByRole("button", { name: "Generate Discovery prompt" }));
      await expectAbsent(page.getByRole("button", { name: "Rotate token" }));
      await expectAbsent(page.getByRole("button", { name: "Archive target" }));
      await expectAbsent(page.getByRole("switch"));
    },
  },
  {
    name: "/targets/[id]/bundles",
    url: () => `/targets/${target.id}/bundles`,
    admin: async (page) => {
      await expectEnabled(page.getByLabel("Bundle zip"));
      await expectEnabled(page.getByRole("button", { name: "Paste manifest instead" }));
      await page.getByLabel("Bundle zip").setInputFiles(target.zip);
      await expectEnabled(page.getByRole("button", { name: "Upload and validate" }));
      await expect(page.getByRole("table", { name: "Bundle versions" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
    },
    viewer: async (page) => {
      await expect(page.getByText(/You have read-only access/)).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expectAbsent(page.getByLabel("Bundle zip"));
      await expectAbsent(page.getByRole("button", { name: "Paste manifest instead" }));
      await expect(page.getByRole("table", { name: "Bundle versions" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
    },
  },
  {
    name: "/targets/[id]/environment",
    url: () => `/targets/${target.id}/environment`,
    admin: async (page) => {
      await expectEnabled(environmentField(page));
      await expectEnabled(page.getByRole("button", { name: "Run health checks", exact: true }));
      await expectDisabled(page.getByRole("button", { name: "Save changes" }));
      await environmentField(page).fill("http://127.0.0.1:9");
      await expectEnabled(page.getByRole("button", { name: "Save changes" }));
    },
    viewer: async (page) => {
      await expect(page.getByText(/You have read-only access/)).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(environmentField(page)).toHaveAttribute("readonly", "", {
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expectAbsent(page.getByRole("button", { name: "Save changes" }));
      await expectDisabled(page.getByRole("button", { name: "Run health checks", exact: true }));
    },
  },
  {
    name: "/catalog?target_id=",
    url: () => `/catalog?target_id=${target.id}`,
    admin: async (page) => {
      await expect(page.getByRole("search", { name: "Filter features" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expectEnabled(page.getByRole("searchbox", { name: "Search" }));
      await expect(page.getByRole("article")).toHaveCount(4, { timeout: SETTLE_TIMEOUT_MS });
    },
    viewer: async (page) => {
      await expect(page.getByRole("search", { name: "Filter features" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expectEnabled(page.getByRole("searchbox", { name: "Search" }));
      await expect(page.getByRole("article")).toHaveCount(4, { timeout: SETTLE_TIMEOUT_MS });
    },
  },
  {
    name: "/settings",
    url: () => "/settings",
    admin: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
      await expectEnabled(page.getByRole("button", { name: "Refresh dependency status" }));
    },
    viewer: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
      await expectEnabled(page.getByRole("button", { name: "Refresh dependency status" }));
    },
  },
];

test.describe.configure({ mode: "serial" });

test("prepares a target with a valid bundle and a viewer account", async ({ page }) => {
  const created = await apiRequest<{ id: string; target_token: string }>(
    page,
    "POST",
    "/api/v1/targets",
    { data: { name: "Hydration Sweep", app_kind: "llm_assistant" } },
  );
  expect(created.status).toBe(201);
  target.id = created.body.id;
  target.token = created.body.target_token;
  const built = buildBundleFixtures(target.token, FIXTURE_DIRECTORY);
  target.zip = path.resolve(built.path("gracie_like.zip"));
  const uploaded = await uploadBundleFile(page, target.zip, `sweep-${target.id}`);
  expect(uploaded.status).toBe(201);
  ensureViewerUser();
});

test("the console watcher reports an error, a warning and a page error", async ({ page }) => {
  const problems = watchConsole(page);
  await page.goto("/settings");

  await page.evaluate(() => {
    console.error("Hydration failed because the server rendered HTML didn't match the client");
    console.warn("A tree hydrated but some attributes of the server rendered HTML didn't match");
    setTimeout(() => {
      throw new Error("Minified React error #418");
    });
  });

  await expect.poll(() => problems().length).toBe(3);
});

test.describe("as an admin", () => {
  test.setTimeout(ROUTE_TIMEOUT_MS);

  for (const route of ROUTES) {
    test(`${route.name}: ${RELOADS} production reloads give no hydration warning and the admin controls stay enabled`, async ({
      page,
    }) => {
      const problems = watchConsole(page);
      await page.goto(route.url());
      for (let attempt = 0; attempt < RELOADS; attempt += 1) {
        await page.reload();
        await route.admin(page);
      }
      expect(problems()).toEqual([]);
    });
  }
});

test.describe("as a viewer", () => {
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });
  test.setTimeout(ROUTE_TIMEOUT_MS);

  test("signs in as the viewer", async ({ page }) => {
    expect(readE2eCredentials().email).not.toBe(VIEWER_CREDENTIALS.email);
    await page.goto("/login");
    await signInThroughForm(page, VIEWER_CREDENTIALS);
    await page.context().storageState({ path: path.join("test-results", "auth", "viewer.json") });
  });

  test.describe("signed in", () => {
    test.use({ storageState: path.join("test-results", "auth", "viewer.json") });

    for (const route of ROUTES) {
      test(`${route.name}: ${RELOADS} production reloads stay read-only and quiet`, async ({
        page,
      }) => {
        const problems = watchConsole(page);
        await page.goto(route.url());
        for (let attempt = 0; attempt < RELOADS; attempt += 1) {
          await page.reload();
          await route.viewer(page);
        }
        expect(problems()).toEqual([]);
      });
    }
  });
});
