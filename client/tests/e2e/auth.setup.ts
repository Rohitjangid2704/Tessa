import { expect, test as setup } from "@playwright/test";
import { authStatePath, type E2eStack } from "./helpers/auth-files";
import { readE2eCredentials } from "./helpers/env";

const SETUP_PROJECT_PREFIX = "setup-";
const SIGN_IN_TIMEOUT_MS = 30_000;

setup("sign in through the login form", async ({ page }, testInfo) => {
  const stack = testInfo.project.name.slice(SETUP_PROJECT_PREFIX.length) as E2eStack;
  const { email, password } = readE2eCredentials();

  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();

  await expect(page).not.toHaveURL(/\/login/, { timeout: SIGN_IN_TIMEOUT_MS });
  await page.context().storageState({ path: authStatePath(stack) });
});
