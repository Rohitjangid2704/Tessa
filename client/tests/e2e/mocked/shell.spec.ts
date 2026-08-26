import { expect, test } from "@playwright/test";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { readE2eCredentials } from "../helpers/env";
import { signInThroughForm } from "../helpers/login";

const emptyPages = [
  { link: "Scenarios", path: "/scenarios", emptyTitle: "No scenarios yet", phase: 2 },
  { link: "Runs", path: "/runs", emptyTitle: "No runs yet", phase: 2 },
  { link: "Findings", path: "/findings", emptyTitle: "No findings yet", phase: 5 },
  { link: "Explore", path: "/explore", emptyTitle: "No sessions yet", phase: 7 },
  { link: "Seeds", path: "/seeds", emptyTitle: "Seeds are not wired up yet", phase: 3 },
] as const;

const navLabels = [
  "Targets",
  "Catalog",
  "Scenarios",
  "Runs",
  "Findings",
  "Labels",
  "Explore",
  "Seeds",
  "Oracle",
  "Settings",
];

test.describe("signed out", () => {
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

  test("redirects to login and keeps the callback URL", async ({ page }) => {
    await page.goto("/runs");

    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fruns$/);
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });

  test("signs in, returns to the page asked for and shows the whole shell", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fsettings$/);

    await signInThroughForm(page, readE2eCredentials());

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link")).toHaveText(navLabels);
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("link", { name: "Tessa home" })).toBeVisible();

    for (const emptyPage of emptyPages) {
      await nav.getByRole("link", { name: emptyPage.link }).click();

      await expect(page).toHaveURL(new RegExp(`${emptyPage.path}$`));
      await expect(page.getByRole("heading", { level: 1, name: emptyPage.link })).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: emptyPage.emptyTitle }),
      ).toBeVisible();
      await expect(page.getByText(`Arrives in Phase ${emptyPage.phase}`)).toBeVisible();
      await expect(nav.getByRole("link", { name: emptyPage.link })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(nav.locator("[aria-current=page]")).toHaveCount(1);
    }

    await page.getByRole("link", { name: "Tessa home" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await expect(page.getByText("Arrives in Phase 8").first()).toBeVisible();
  });
});

test.describe("signed in", () => {
  test("lists the pages with the Truth group, the user menu and a working sign out", async ({
    page,
  }) => {
    await page.goto("/");

    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link")).toHaveText(navLabels);
    await expect(page.getByRole("link", { name: "Tessa home" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.getByRole("button", { name: /tessa\.local/ }).click();
    await expect(page.getByText(/^Role: /)).toBeVisible();
    await page.getByRole("menuitem", { name: "Sign out" }).click();

    await expect(page).toHaveURL(/\/login/);
    await page.goto("/targets");
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Ftargets$/);
  });

  test("skips to the main content from the keyboard", async ({ page }) => {
    await page.goto("/targets");

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to content" });
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/#main-content$/);
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("collapses the sidebar and remembers it across a reload", async ({ page }) => {
    await page.goto("/targets");
    const sidebar = page.locator("[data-slot=sidebar][data-state]");
    await expect(sidebar).toHaveAttribute("data-state", "expanded");

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");

    await page.reload();
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  });
});
