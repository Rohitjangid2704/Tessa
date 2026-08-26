import { expect, type Page } from "@playwright/test";
import type { E2eCredentials } from "./env";

const SIGN_IN_TIMEOUT_MS = 30_000;

export async function signInThroughForm(page: Page, credentials: E2eCredentials): Promise<void> {
  await page.getByLabel(/email/i).fill(credentials.email);
  await page.getByLabel(/password/i).fill(credentials.password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: SIGN_IN_TIMEOUT_MS });
}
