import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { apiOrigin } from "../helpers/env";
import { signInThroughForm } from "../helpers/login";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const SECRET_PATTERN = /ipt_[A-Za-z0-9_-]{43}/;
const SERVER_MAX_DAYS = 90;

const pageErrors: string[] = [];

test.beforeEach(async ({ page, request }) => {
  pageErrors.length = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await resetMockApi(request);
});

test.afterEach(async ({ request }) => {
  await clearMockFaults(request);
  expect(pageErrors).toEqual([]);
});

async function seedTokens(request: APIRequestContext, variant: "none" | "full" | "expired") {
  const response = await request.post(`${apiOrigin()}/__mock/stage11/seed`, {
    data: { variants: { tokens: variant } },
  });
  expect(response.ok()).toBe(true);
}

async function openCreateDialog(page: Page) {
  await page.getByRole("button", { name: "New token" }).click();
  return page.getByRole("dialog", { name: "New personal token" });
}

async function createToken(page: Page, name: string, expiry?: string) {
  const dialog = await openCreateDialog(page);
  await dialog.getByLabel("Name").fill(name);
  if (expiry !== undefined) {
    await dialog.getByLabel(/Expires after/).fill(expiry);
  }
  await dialog.getByRole("button", { name: "Create token" }).click();
  return dialog;
}

test.describe("personal tokens", () => {
  test("mints a token, shows it once with a copy button, and never again", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(baseURL ?? "http://localhost:3000").origin,
    });
    await page.goto("/settings/tokens");
    await expect(page.getByRole("heading", { level: 1, name: "Personal tokens" })).toBeVisible();
    await expect(page.getByText("No tokens yet")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Connect Claude Code" })).toBeVisible();

    await createToken(page, "laptop");
    const shown = page.getByRole("dialog", { name: "Token created" });
    await expect(shown.getByText("This token is shown once")).toBeVisible();
    const field = shown.getByLabel("Personal token");
    const secret = await field.inputValue();
    expect(secret).toMatch(SECRET_PATTERN);

    await shown.getByRole("button", { name: /Copy/ }).click();
    await expect(shown.getByText("Copied", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);

    await shown.getByRole("button", { name: "I copied it" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const row = page.getByRole("row", { name: /laptop/ });
    await expect(row).toContainText(secret.slice(0, 8));
    await expect(row).toContainText("Active");
    expect(await page.content()).not.toContain(secret);

    await page.reload();
    await expect(page.getByRole("row", { name: /laptop/ })).toBeVisible();
    expect(await page.content()).not.toContain(secret);
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...window.localStorage, ...window.sessionStorage }),
    );
    expect(stored).not.toContain(secret);
  });

  test("revokes a token after its name is typed", async ({ page }) => {
    await page.goto("/settings/tokens");
    await createToken(page, "ci runner");
    await page.getByRole("button", { name: "I copied it" }).click();

    await page.getByRole("button", { name: /Revoke\s*ci runner/ }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke this token" });
    const confirm = dialog.getByRole("button", { name: "Revoke token" });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox").fill("ci runne");
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox").fill("ci runner");
    await confirm.click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    const row = page.getByRole("row", { name: /ci runner/ });
    await expect(row).toContainText("Revoked");
    await expect(row.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
  });

  test("shows active, expired and revoked rows", async ({ page, request }) => {
    await seedTokens(request, "expired");
    await page.goto("/settings/tokens");

    await expect(page.getByRole("row", { name: /laptop/ })).toContainText("Active");
    await expect(page.getByRole("row", { name: /old ci runner/ })).toContainText("Expired");
    await expect(page.getByRole("row", { name: /lost phone/ })).toContainText("Revoked");
    await expect(page.getByRole("button", { name: /Revoke/ })).toHaveCount(1);
    await expect(page.getByText("1 of 10 active tokens in use.")).toBeVisible();
  });

  test("shows the 409 token limit inline and recovers after a revoke", async ({
    page,
    request,
  }) => {
    await seedTokens(request, "full");
    await page.goto("/settings/tokens");
    await expect(page.getByText("10 of 10 active tokens in use.")).toBeVisible();

    const dialog = await createToken(page, "one too many");
    await expect(dialog.getByText("Token limit reached")).toBeVisible();
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: /Revoke\s*laptop/ }).click();
    const confirm = page.getByRole("dialog", { name: "Revoke this token" });
    await confirm.getByRole("textbox").fill("laptop");
    await confirm.getByRole("button", { name: "Revoke token" }).click();
    await expect(page.getByText("9 of 10 active tokens in use.")).toBeVisible();

    await createToken(page, "now it fits");
    await expect(page.getByRole("dialog", { name: "Token created" })).toBeVisible();
  });

  test("names the server maximum when the expiry is too long", async ({ page }) => {
    await page.goto("/settings/tokens");
    const dialog = await createToken(page, "long lived", "365");

    await expect(
      dialog.getByText(`The server allows at most ${SERVER_MAX_DAYS} days`),
    ).toBeVisible();
    await expect(dialog.getByText(`The server maximum is ${SERVER_MAX_DAYS} days.`)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Token created" })).toHaveCount(0);

    await dialog.getByLabel(/Expires after/).fill("30");
    await dialog.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByRole("dialog", { name: "Token created" })).toBeVisible();
  });

  test("keeps the token dialog open on an outside click until I copied it", async ({ page }) => {
    await page.goto("/settings/tokens");
    await createToken(page, "careful");
    const shown = page.getByRole("dialog", { name: "Token created" });
    await expect(shown).toBeVisible();

    await page.mouse.click(4, 4);
    await expect(shown).toBeVisible();
    await shown.getByRole("button", { name: "I copied it" }).click();
    await expect(shown).toHaveCount(0);
  });

  test("is listed in the settings sub-navigation", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("link", { name: "Personal tokens" }).click();
    await expect(page).toHaveURL(/\/settings\/tokens$/);
    await expect(page.getByRole("link", { name: "Personal tokens" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

test.describe("viewer role", () => {
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

  test("a viewer manages their own tokens and sees no admin sections", async ({ page }) => {
    await page.goto("/login");
    await signInThroughForm(page, {
      email: "viewer@tessa.local",
      password: "dev-only-viewer-password-1",
    });

    await page.goto("/settings/tokens");
    await expect(page.getByRole("heading", { level: 1, name: "Personal tokens" })).toBeVisible();
    await createToken(page, "viewer laptop");
    await expect(page.getByRole("dialog", { name: "Token created" })).toBeVisible();
    await page.getByRole("button", { name: "I copied it" }).click();
    await expect(page.getByRole("row", { name: /viewer laptop/ })).toContainText("Active");
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  });
});
