import { expect, test, type Page } from "@playwright/test";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { expectNoAxeViolations } from "../helpers/axe";
import { clearMockFaults, resetMockApi, setMockFaults } from "../helpers/mock-api";

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
  test.describe(`axe in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test.describe("signed out", () => {
      test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

      test("/login has no violations", async ({ page }) => {
        await page.goto("/login");
        await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
        await expectTheme(page, scheme);

        await expectNoAxeViolations(page);
      });
    });

    test.describe("signed in", () => {
      test.beforeEach(async ({ request }) => {
        await resetMockApi(request);
      });

      test.afterEach(async ({ request }) => {
        await clearMockFaults(request);
      });

      test("/ has no violations", async ({ page }) => {
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
        await expectTheme(page, scheme);

        await expectNoAxeViolations(page);
      });

      test("/settings has no violations once loaded", async ({ page }) => {
        await page.goto("/settings");
        await expect(page.getByRole("row", { name: /Database/ })).toBeVisible();
        await expect(page.getByRole("link", { name: "bundle.v1.json" })).toBeVisible();
        await expectTheme(page, scheme);

        await expectNoAxeViolations(page);
      });

      test("/settings has no violations with a dependency down", async ({ page, request }) => {
        await setMockFaults(request, { dependencies_down: ["temporal", "laya"] });
        await page.goto("/settings");
        await expect(
          page.getByRole("region", { name: "Dependencies" }).getByRole("alert"),
        ).toContainText("2 dependencies are down");

        await expectNoAxeViolations(page);
      });

      test("/settings has no violations when the API is unreachable", async ({ page }) => {
        await page.route("**/health", (route) => route.abort("connectionrefused"));
        await page.goto("/settings");
        await expect(page.getByRole("heading", { name: "The API is not reachable" })).toBeVisible();

        await expectNoAxeViolations(page);
      });

      test("a settled error toast has no violations", async ({ page }) => {
        await page.route("**/api/v1/users/me", (route) =>
          route.fulfill({
            status: 500,
            headers: {
              "access-control-allow-origin": "*",
              "access-control-expose-headers": "X-Request-ID",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              error: {
                code: "internal_error",
                message: "Unhandled error",
                request_id: "req-toast-a11y",
                details: [],
              },
            }),
          }),
        );
        await page.goto("/dev/hello");
        const toast = page.locator("[data-sonner-toast]");
        await expect(toast).toContainText("Server error", { timeout: 20_000 });
        await expect
          .poll(() =>
            toast.evaluate(
              (element) =>
                element
                  .getAnimations({ subtree: true })
                  .filter(({ playState }) => playState === "running").length,
            ),
          )
          .toBe(0);
        await expectTheme(page, scheme);

        await expectNoAxeViolations(page);
      });

      test("an empty page has no violations", async ({ page }) => {
        await page.goto("/targets");
        await expect(page.getByRole("heading", { level: 1, name: "Targets" })).toBeVisible();

        await expectNoAxeViolations(page);
      });
    });
  });
}
