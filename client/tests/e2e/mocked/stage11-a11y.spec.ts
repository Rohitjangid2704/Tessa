import { expect, test, type Page } from "@playwright/test";
import { STAGE_ONE_IDS } from "../../../mocks/stage1/seed";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { expectNoAxeViolations } from "../helpers/axe";
import { signInThroughForm } from "../helpers/login";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const SETTLE_TIMEOUT_MS = 15_000;
const colorSchemes = ["light", "dark"] as const;

const accounts = [
  { role: "admin", email: "admin@tessa.local", password: "dev-only-admin-password-1" },
  { role: "member", email: "member@tessa.local", password: "dev-only-member-password-1" },
  { role: "viewer", email: "viewer@tessa.local", password: "dev-only-viewer-password-1" },
] as const;

type Role = (typeof accounts)[number]["role"];

interface RouteCase {
  name: string;
  path: string;
  settled: (page: Page, role: Role) => Promise<void>;
}

const routeCases: readonly RouteCase[] = [
  {
    name: "/settings/tokens",
    path: "/settings/tokens",
    settled: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Personal tokens" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Connect Claude Code" })).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
    },
  },
  {
    name: "/targets/[id]/proposal",
    path: `/targets/${STAGE_ONE_IDS.gracie}/proposal`,
    settled: async (page) => {
      await expect(page.getByRole("article").first()).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    },
  },
  {
    name: "/settings/activity",
    path: "/settings/activity",
    settled: async (page, role) => {
      if (role === "admin") {
        await expect(page.locator('[data-slot="audit-row"]').first()).toBeVisible({
          timeout: SETTLE_TIMEOUT_MS,
        });
        return;
      }
      await expect(page.getByRole("heading", { name: "Admin access required" })).toBeVisible();
    },
  },
];

test.beforeEach(async ({ request }) => {
  await resetMockApi(request);
});

test.afterEach(async ({ request }) => {
  await clearMockFaults(request);
});

for (const scheme of colorSchemes) {
  for (const account of accounts) {
    test.describe(`axe on the Stage 11 routes as ${account.role} in ${scheme} mode`, () => {
      test.use({ colorScheme: scheme, storageState: SIGNED_OUT_STORAGE_STATE });

      for (const routeCase of routeCases) {
        test(`${routeCase.name} has no violations`, async ({ page }) => {
          await page.goto("/login");
          await signInThroughForm(page, account);
          await page.goto(routeCase.path);
          await routeCase.settled(page, account.role);
          const html = page.locator("html");
          if (scheme === "dark") {
            await expect(html).toHaveClass(/\bdark\b/);
          } else {
            await expect(html).not.toHaveClass(/\bdark\b/);
          }

          await expectNoAxeViolations(page);
        });
      }
    });
  }
}

for (const scheme of colorSchemes) {
  test.describe(`axe on the activity states in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("the target overview with an active, an ended and an inactive session", async ({
      page,
      request,
    }) => {
      const origin = new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").origin;
      await request.post(`${origin}/__mock/stage11/agent-session`, {
        data: { cwd_label: "forgotten", started_hours_ago: 14 },
      });
      await page.goto(`/targets/${STAGE_ONE_IDS.gracie}`);
      await expect(page.locator('[data-slot="agent-session-row"]')).toHaveCount(3, {
        timeout: SETTLE_TIMEOUT_MS,
      });

      await expectNoAxeViolations(page);
    });

    test("the audit log with a session filter and with no match", async ({ page }) => {
      await page.goto("/settings/activity?session=0198f6f2-aaaa-7bbb-8ccc-000000000011");
      await expect(page.locator('[data-slot="audit-row"]').first()).toBeVisible({
        timeout: SETTLE_TIMEOUT_MS,
      });
      await expectNoAxeViolations(page);

      await page.goto("/settings/activity?via=svc");
      await expect(page.getByRole("heading", { name: "No events match" })).toBeVisible();
      await expectNoAxeViolations(page);
    });
  });
}
