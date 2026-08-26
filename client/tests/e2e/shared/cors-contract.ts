import { expect, test, type Page } from "@playwright/test";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { apiOrigin } from "../helpers/env";

interface BrowserFetchResult {
  outcome: "response" | "network_error";
  status?: number;
  requestId?: string | null;
  errorCode?: string | null;
}

async function browserFetch(
  page: Page,
  url: string,
  init: { headers?: Record<string, string>; credentials?: "include" | "omit" },
): Promise<BrowserFetchResult> {
  return page.evaluate(
    async ({ target, options }) => {
      try {
        const response = await fetch(target, options);
        const body = await response.json().catch(() => null);
        return {
          outcome: "response" as const,
          status: response.status,
          requestId: response.headers.get("x-request-id"),
          errorCode: body?.error?.code ?? null,
        };
      } catch {
        return { outcome: "network_error" as const };
      }
    },
    { target: url, options: init },
  );
}

export function defineCorsContractTests(): void {
  test.describe("API CORS in a real browser (contract 0.12)", () => {
    test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

    test.beforeEach(async ({ page }) => {
      await page.goto("/login");
    });

    test("a preflighted request with Authorization and X-Request-ID is readable", async ({
      page,
    }) => {
      const result = await browserFetch(page, `${apiOrigin()}/api/v1/users/me`, {
        headers: {
          Authorization: "Bearer not-a-real-token",
          "X-Request-ID": "e2e-cors-request-0001",
        },
      });

      expect(result).toEqual({
        outcome: "response",
        status: 401,
        requestId: "e2e-cors-request-0001",
        errorCode: "unauthenticated",
      });
    });

    test("the error body of a non-2xx response is readable cross-origin", async ({ page }) => {
      const result = await browserFetch(page, `${apiOrigin()}/api/v1/does-not-exist`, {});

      expect(result.outcome).toBe("response");
      expect(result.status).toBe(404);
      expect(result.errorCode).toBe("not_found");
      expect(result.requestId).toBeTruthy();
    });

    test("a request header outside the allowed list fails the preflight", async ({ page }) => {
      const result = await browserFetch(page, `${apiOrigin()}/health`, {
        headers: { "X-Service-Key": "must-not-be-sent-by-a-browser" },
      });

      expect(result.outcome).toBe("network_error");
    });

    test("a credentialed request is refused because credentials are not allowed", async ({
      page,
    }) => {
      const result = await browserFetch(page, `${apiOrigin()}/health`, { credentials: "include" });

      expect(result.outcome).toBe("network_error");
    });

    test("a plain GET without custom headers works without a preflight", async ({ page }) => {
      const result = await browserFetch(page, `${apiOrigin()}/health`, {});

      expect(result.outcome).toBe("response");
      expect(result.status).toBe(200);
    });
  });
}
