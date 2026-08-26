import { expect, test, type Page } from "@playwright/test";
import { STAGE_ONE_IDS } from "../../../mocks/stage1/seed";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { expectNoAxeViolations } from "../helpers/axe";
import { signInThroughForm } from "../helpers/login";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const { gracie, billing, brokenImport } = STAGE_ONE_IDS;
const SETTLE_TIMEOUT_MS = 15_000;
const RELOADS = 12;
const FAILED_RESOURCE_LOG = "Failed to load resource";
const CATALOG_REQUEST = /\/api\/v1\/catalog(\?|$)/;

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

function cards(page: Page) {
  return page.getByRole("article");
}

function countLine(page: Page) {
  return page.getByText(/ features? in \d+ areas?$/);
}

async function openCatalog(page: Page, search = `?target_id=${gracie}`): Promise<void> {
  await page.goto(`/catalog${search}`);
  await expect(page.getByRole("search", { name: "Filter features" })).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
}

async function chooseFilter(page: Page, filter: string, option: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${filter}: `) }).click();
  await page.getByRole("checkbox", { name: option, exact: true }).check();
  await page.keyboard.press("Escape");
}

test.describe("catalog of a target with a valid bundle", () => {
  test("lists the areas with counts and every feature card", async ({ page }) => {
    await openCatalog(page);

    await expect(page.getByRole("heading", { level: 1, name: "Catalog" })).toBeVisible();
    await expect(cards(page)).toHaveCount(15);
    await expect(countLine(page)).toHaveText("15 features in 5 areas");
    const headings = await page
      .getByRole("heading", { level: 2 })
      .filter({ hasText: / features?$/ })
      .allTextContents();
    expect(headings).toEqual([
      "Account & Access 4 features",
      "Guest Requests 3 features",
      "Reports 2 features",
      "Smart Log 3 features",
      "Streaming & Jobs 3 features",
    ]);
    await expect(page.getByText("Bundle version 2")).toBeVisible();
  });

  test("shows kind, interfaces, roles, flag and confidence on the card", async ({ page }) => {
    await openCatalog(page);
    const card = page.getByRole("article", { name: "guest_requests.write.create_service_request" });

    await expect(card.getByText("Write", { exact: true })).toBeVisible();
    await expect(card.getByText("High confidence")).toBeVisible();
    await expect(card.getByRole("list", { name: "Interfaces" })).toContainText("chat_sse");
    await expect(card.getByRole("list", { name: "Roles" })).toContainText("front_desk");
    await expect(card.getByRole("list", { name: "Flag" })).toContainText(
      "GUEST_REQUESTS_WRITE_ENABLED",
    );
  });

  test("expands a write feature to its examples, cleanup and write details", async ({ page }) => {
    await openCatalog(page);
    const card = page.getByRole("article", { name: "guest_requests.write.create_service_request" });

    await card.getByRole("button", { name: /^Details of / }).click();

    await expect(card.getByRole("region", { name: "Preconditions" })).toContainText(
      "role.guest.logged_in",
    );
    const examples = card.getByRole("region", { name: "Examples (2)" });
    await expect(examples).toContainText("I need two extra towels in room 20003");
    await expect(examples).toContainText('"method": "POST"');
    await expect(examples).toContainText("guest_request_by_id");
    await expect(card.getByRole("region", { name: "Cleanup" })).toContainText(
      "Delete the created request by id",
    );
    const writes = card.getByRole("region", { name: "Write details" });
    await expect(writes).toContainText("guest_requests");
    await expect(writes).toContainText("Confirm button in the chat");
    await expect(writes).toContainText('"status": "open"');
  });

  test("collapses an area from its heading", async ({ page }) => {
    await openCatalog(page);

    await page.getByRole("button", { name: /^Reports/ }).click();

    await expect(cards(page)).toHaveCount(13);
    await expect(page.getByRole("button", { name: /^Reports/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("shows the roles and interfaces of the bundle", async ({ page }) => {
    await openCatalog(page);

    await page.getByRole("button", { name: "Roles and interfaces" }).click();

    const summary = page.getByRole("region", { name: "Catalog summary" });
    await expect(summary).toContainText("housekeeping_lead");
    await expect(summary).toContainText("/api/v1/chat");
  });

  test("links to the bundle it was built from", async ({ page }) => {
    await openCatalog(page);

    await page.getByRole("link", { name: "View bundle" }).click();

    await expect(page).toHaveURL(new RegExp(`/targets/${gracie}/bundles/[0-9a-f-]{36}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Gracie" })).toBeVisible();
  });
});

test.describe("catalog filters in the URL", () => {
  test("writes a kind filter to the URL, narrows the list and restores it on reload", async ({
    page,
  }) => {
    await openCatalog(page);

    await chooseFilter(page, "Kind", "Write");

    await expect(cards(page)).toHaveCount(2);
    await expect(page).toHaveURL(new RegExp(`target_id=${gracie}&kind=write$`));
    await expect(countLine(page)).toHaveText("Showing 2 of 15 features in 2 areas");
    await expect(
      page.getByRole("heading", { level: 2, name: "Guest Requests 1 of 3 features" }),
    ).toBeVisible();

    await page.reload();

    await expect(cards(page)).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Kind: 1 selected" })).toBeVisible();
  });

  test("combines area, confidence and search and clears them together", async ({ page }) => {
    await openCatalog(page);

    await chooseFilter(page, "Area", "Guest Requests");
    await chooseFilter(page, "Confidence", "High");
    await expect(cards(page)).toHaveCount(2);
    await page.getByRole("searchbox", { name: "Search" }).fill("list");
    await expect(cards(page)).toHaveCount(1);
    await expect(
      page.getByRole("article", { name: "guest_requests.read.list_open" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/area=Guest\+Requests/);
    await expect(page).toHaveURL(/confidence=high/);
    await expect(page).toHaveURL(/q=list/);

    await page.getByRole("button", { name: "Clear filters" }).click();

    await expect(cards(page)).toHaveCount(15);
    await expect(page).toHaveURL(new RegExp(`/catalog\\?target_id=${gracie}$`));
  });

  test("filters by role and by interface", async ({ page }) => {
    await openCatalog(page);

    await chooseFilter(page, "Interface", "events_sse");
    await expect(cards(page)).toHaveCount(1);
    await expect(
      page.getByRole("article", { name: "streaming.stream.property_events" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await chooseFilter(page, "Role", "manager");

    await expect(page).toHaveURL(/role=manager/);
    await expect(
      page.getByRole("article", { name: "reports.read.occupancy_summary" }),
    ).toBeVisible();
    await expect(page.getByRole("article", { name: "access.auth.login_staff" })).toBeVisible();
  });

  test("keeps the area options of the whole bundle while a filter is active", async ({ page }) => {
    await openCatalog(page, `?target_id=${gracie}&kind=write`);
    await expect(cards(page)).toHaveCount(2);

    await page.getByRole("button", { name: /^Area: / }).click();

    await expect(page.getByRole("checkbox")).toHaveCount(5);
  });

  test("explains a search with no match and recovers on clear", async ({ page }) => {
    await openCatalog(page, `?target_id=${gracie}&q=zzzz`);

    await expect(page.getByRole("heading", { name: "No features match" })).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    await page.getByRole("main").getByRole("button", { name: "Clear filters" }).first().click();

    await expect(cards(page)).toHaveCount(15);
  });
});

test.describe("catalog without a catalog to show", () => {
  test("a target without a bundle gets the intake call to action", async ({ page }) => {
    await page.goto(`/catalog?target_id=${billing}`);

    await expect(page.getByRole("heading", { name: "No valid bundle yet" })).toBeVisible();
    await expect(page.getByRole("search")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await page.getByRole("link", { name: "Upload a bundle" }).click();

    await expect(page).toHaveURL(new RegExp(`/targets/${billing}/bundles$`));
    await expect(page.getByRole("heading", { level: 2, name: "Add a version" })).toBeVisible();
  });

  test("a target whose latest bundle is invalid links to the errors", async ({ page }) => {
    await page.goto(`/catalog?target_id=${brokenImport}`);

    const alert = page.getByRole("main").getByRole("alert").filter({ hasText: "did not validate" });
    await expect(alert).toContainText("Version 1 did not validate");
    await alert.getByRole("link", { name: /See the validation errors for version 1/ }).click();

    await expect(page).toHaveURL(new RegExp(`/targets/${brokenImport}/bundles/[0-9a-f-]{36}$`));
    await expect(page.getByRole("heading", { level: 2, name: "Version 1" })).toBeVisible();
  });

  test("an explicit invalid bundle id gets the same empty state with the errors link", async ({
    page,
  }) => {
    await page.goto(`/targets/${brokenImport}/bundles`);
    const href = await page
      .getByRole("link", { name: "Version 1", exact: true })
      .getAttribute("href");
    const bundleId = href?.split("/").pop() ?? "";

    await page.goto(`/catalog?target_id=${brokenImport}&bundle_id=${bundleId}`);

    await expect(page.getByRole("heading", { name: "This bundle has no catalog" })).toBeVisible();
    await expect(page.getByText("Version 1 did not validate")).toBeVisible();
  });

  test("asks for a target, and picking one loads its catalog", async ({ page }) => {
    await page.goto("/catalog");

    await expect(page.getByRole("heading", { level: 2, name: "Choose a target" })).toBeVisible();
    await page.getByRole("main").getByRole("combobox", { name: "Choose a target" }).click();
    await page.getByRole("option", { name: "Gracie" }).click();

    await expect(page).toHaveURL(new RegExp(`/catalog\\?target_id=${gracie}$`));
    await expect(cards(page)).toHaveCount(15);
  });

  test("an unknown target is reported without a retry loop", async ({ page }) => {
    await page.goto("/catalog?target_id=0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9999");

    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "Target or bundle not found",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  });

  test("shows the error with its request id and recovers on retry", async ({ page }) => {
    let failures = 3;
    await page.route(CATALOG_REQUEST, async (route) => {
      if (failures > 0) {
        failures -= 1;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "internal_error",
              message: "Something broke",
              request_id: "req-e2e-catalog",
              details: [],
            },
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto(`/catalog?target_id=${gracie}`);

    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "Could not load the catalog",
    );
    await expect(page.getByText("Request ID: req-e2e-catalog")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();

    await expect(cards(page)).toHaveCount(15);
  });
});

test.describe("catalog navigation", () => {
  test("opens from the sidebar with the current target", async ({ page }) => {
    await page.goto(`/targets/${gracie}`);
    await expect(page.getByRole("heading", { level: 1, name: "Gracie" })).toBeVisible();

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Catalog" })
      .click();

    await expect(page).toHaveURL(new RegExp(`/catalog\\?target_id=${gracie}$`));
    await expect(cards(page)).toHaveCount(15);
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Catalog" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("switching target from the header loads that target's catalog", async ({ page }) => {
    await openCatalog(page);

    await page.getByRole("combobox", { name: "Current target" }).click();
    await page.getByRole("option", { name: "Billing API" }).click();

    await expect(page).toHaveURL(new RegExp(`/catalog\\?target_id=${billing}$`));
    await expect(page.getByRole("heading", { name: "No valid bundle yet" })).toBeVisible();
  });

  test("never leaves the filter bar stuck after a reload", async ({ page }) => {
    for (let attempt = 0; attempt < RELOADS; attempt += 1) {
      await page.goto(`/catalog?target_id=${gracie}&kind=write`);
      await expect(page.getByRole("searchbox", { name: "Search" })).toBeEnabled({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expect(cards(page)).toHaveCount(2, { timeout: SETTLE_TIMEOUT_MS });
    }
  });
});

test.describe("catalog for a viewer", () => {
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

  test("can read the catalog", async ({ page }) => {
    await page.goto("/login");
    await signInThroughForm(page, {
      email: "viewer@tessa.local",
      password: "dev-only-viewer-password-1",
    });

    await openCatalog(page);

    await expect(cards(page)).toHaveCount(15);
  });
});

test.describe("large catalog", () => {
  test("starts collapsed at 500 features, opens an area on demand and filters", async ({
    page,
  }) => {
    await page.route(CATALOG_REQUEST, async (route) => {
      const url = new URL(route.request().url());
      const text = url.searchParams.get("q")?.toLowerCase();
      const items = Array.from({ length: 500 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        bundle_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b7777",
        feature_id: `area_${index % 25}.read.feature_${index}`,
        area: `Area ${String(index % 25).padStart(2, "0")}`,
        kind: "read",
        description: `Feature number ${index}`,
        interface_ids: ["rest_api"],
        roles: ["all"],
        flag: "none",
        preconditions: [],
        examples: [{ ask: "Ask", expected: "Expect" }],
        invariants: ["no_5xx"],
        cleanup: "none",
        confidence: "medium",
      })).filter((item) => text === undefined || item.description.toLowerCase().includes(text));
      const areas = new Map<string, typeof items>();
      for (const item of items) {
        areas.set(item.area, [...(areas.get(item.area) ?? []), item]);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          bundle_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b7777",
          bundle_version: 3,
          roles: [{ id: "admin", level: 3, description: "Admin" }],
          interfaces: [{ id: "rest_api", kind: "http", base_path: "/api" }],
          areas: [...areas].map(([name, areaItems]) => ({ name, items: areaItems })),
        }),
      });
    });

    await openCatalog(page);

    await expect(countLine(page)).toHaveText("500 features in 25 areas");
    await expect(page.locator("[data-slot=large-catalog-note]")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Area \d\d / })).toHaveCount(25);
    await expect(cards(page)).toHaveCount(0);
    await page.getByRole("button", { name: /^Area 00 / }).click();
    await expect(cards(page)).toHaveCount(20);
    await page.getByRole("searchbox", { name: "Search" }).fill("number 49");
    await expect(cards(page)).toHaveCount(11);
  });
});

const colorSchemes = ["light", "dark"] as const;

async function expectTheme(page: Page, scheme: (typeof colorSchemes)[number]) {
  const html = page.locator("html");
  if (scheme === "dark") {
    await expect(html).toHaveClass(/\bdark\b/);
  } else {
    await expect(html).not.toHaveClass(/\bdark\b/);
  }
}

for (const scheme of colorSchemes) {
  test.describe(`axe on the catalog in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("loaded with every card collapsed", async ({ page }) => {
      await openCatalog(page);
      await expect(cards(page)).toHaveCount(15);
      await expectTheme(page, scheme);

      await expectNoAxeViolations(page);
    });

    test("with a read and a write card expanded and the roles panel open", async ({ page }) => {
      await openCatalog(page);
      await page
        .getByRole("article", { name: "smart_log.read.open_maintenance" })
        .getByRole("button", { name: /^Details of / })
        .click();
      await page
        .getByRole("article", { name: "guest_requests.write.create_service_request" })
        .getByRole("button", { name: /^Details of / })
        .click();
      await page.getByRole("button", { name: "Roles and interfaces" }).click();
      await expect(page.getByRole("region", { name: "Write details" })).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("with filters applied and the filter popover open", async ({ page }) => {
      await openCatalog(page, `?target_id=${gracie}&kind=write&confidence=high`);
      await expect(cards(page)).toHaveCount(1);
      await page.getByRole("button", { name: /^Area: / }).click();
      await expect(page.getByRole("checkbox", { name: "Reports" })).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("with no matching feature", async ({ page }) => {
      await openCatalog(page, `?target_id=${gracie}&q=zzzz`);
      await expect(page.getByRole("heading", { name: "No features match" })).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("for a target without a bundle", async ({ page }) => {
      await page.goto(`/catalog?target_id=${billing}`);
      await expect(page.getByRole("heading", { name: "No valid bundle yet" })).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("for a target whose latest bundle is invalid", async ({ page }) => {
      await page.goto(`/catalog?target_id=${brokenImport}`);
      await expect(page.getByText("Version 1 did not validate")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("without a target", async ({ page }) => {
      await page.goto("/catalog");
      await expect(page.getByRole("heading", { level: 2, name: "Choose a target" })).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("in the error state", async ({ page }) => {
      await page.route(CATALOG_REQUEST, (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "internal_error", message: "Boom", request_id: "req-axe", details: [] },
          }),
        }),
      );
      await page.goto(`/catalog?target_id=${gracie}`);
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "Could not load the catalog",
      );

      await expectNoAxeViolations(page);
    });
  });
}
