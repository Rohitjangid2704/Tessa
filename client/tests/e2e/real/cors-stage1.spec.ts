import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { apiOrigin } from "../helpers/env";
import { apiRequest, mintApiToken, uploadBundleFile } from "./support/api";
import { buildBundleFixtures } from "./support/fixtures";

const FIXTURE_DIRECTORY = path.join("test-results", "fixtures", "cors-stage1");

const target = { id: "", zip: "" };

interface BrowserResult {
  outcome: "response" | "network_error";
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

async function browserFetch(
  page: Page,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
): Promise<BrowserResult> {
  return page.evaluate(
    async ({ address, options }) => {
      try {
        const response = await fetch(address, options);
        const text = await response.text();
        return {
          outcome: "response" as const,
          status: response.status,
          headers: {
            "idempotency-replayed": response.headers.get("idempotency-replayed") ?? "",
            "x-request-id": response.headers.get("x-request-id") ?? "",
          },
          body: text === "" ? null : (JSON.parse(text) as unknown),
        };
      } catch {
        return { outcome: "network_error" as const };
      }
    },
    { address: url, options: init },
  );
}

test.describe.configure({ mode: "serial" });

test("prepares a target with a valid bundle", async ({ page }) => {
  const created = await apiRequest<{ id: string; target_token: string }>(
    page,
    "POST",
    "/api/v1/targets",
    { data: { name: "CORS Stage 1", app_kind: "api" } },
  );
  expect(created.status).toBe(201);
  target.id = created.body.id;
  const built = buildBundleFixtures(created.body.target_token, FIXTURE_DIRECTORY);
  target.zip = path.resolve(built.path("minimal_valid.zip"));
  const uploaded = await uploadBundleFile(page, target.zip, `cors-${target.id}`);
  expect(uploaded.status).toBe(201);
});

test.describe("Stage 1 requests from the browser origin", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  });

  test("the preflight of a PATCH with Authorization is allowed for the app origin", async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? "http://localhost:3000").origin;

    const preflight = await page.request.fetch(
      `${apiOrigin()}/api/v1/targets/${target.id}/environment`,
      {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "PATCH",
          "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
        },
      },
    );

    expect(preflight.status()).toBeLessThan(300);
    const headers = preflight.headers();
    expect(headers["access-control-allow-origin"]).toBe(origin);
    expect(headers["access-control-allow-methods"]).toContain("PATCH");
    expect(headers["access-control-allow-headers"]?.toLowerCase()).toContain("authorization");
    expect(headers["access-control-allow-headers"]?.toLowerCase()).toContain("idempotency-key");
  });

  test("a PATCH with Authorization and a JSON body is readable cross-origin", async ({ page }) => {
    const token = await mintApiToken(page);

    const result = await browserFetch(
      page,
      `${apiOrigin()}/api/v1/targets/${target.id}/environment`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ set: { NOTES_BASE_URL: "http://127.0.0.1:9" }, clear: [] }),
      },
    );

    expect(result.outcome).toBe("response");
    expect(result.status).toBe(200);
    expect(result.headers?.["x-request-id"]).toBeTruthy();
    const items = (result.body as { items: { name: string; value: string | null }[] }).items;
    expect(items.find((item) => item.name === "NOTES_BASE_URL")?.value).toBe("http://127.0.0.1:9");
  });

  test("a POST with no body and no content type is readable cross-origin", async ({ page }) => {
    const token = await mintApiToken(page);
    const headers = { Authorization: `Bearer ${token}` };

    const health = await browserFetch(
      page,
      `${apiOrigin()}/api/v1/targets/${target.id}/health-checks`,
      { method: "POST", headers },
    );
    const rotate = await browserFetch(
      page,
      `${apiOrigin()}/api/v1/targets/${target.id}/token/rotate`,
      { method: "POST", headers },
    );

    expect(health.outcome).toBe("response");
    expect(health.status).toBe(200);
    expect((health.body as { interfaces: unknown[] }).interfaces.length).toBeGreaterThan(0);
    expect(rotate.outcome).toBe("response");
    expect(rotate.status).toBe(200);
    expect((rotate.body as { id: string }).id).toBe(target.id);
  });

  test("the idempotency replay header and the request id are exposed to the browser", async ({
    page,
  }) => {
    const token = await mintApiToken(page);
    const encoded = readFileSync(target.zip).toString("base64");
    const upload = (key: string) =>
      page.evaluate(
        async ({ address, bearer, idempotencyKey, content }) => {
          const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
          const form = new FormData();
          form.append("file", new File([bytes], "minimal_valid.zip", { type: "application/zip" }));
          const response = await fetch(address, {
            method: "POST",
            headers: { Authorization: `Bearer ${bearer}`, "Idempotency-Key": idempotencyKey },
            body: form,
          });
          return {
            status: response.status,
            replayed: response.headers.get("idempotency-replayed"),
            requestId: response.headers.get("x-request-id"),
          };
        },
        {
          address: `${apiOrigin()}/api/v1/bundles`,
          bearer: token,
          idempotencyKey: key,
          content: encoded,
        },
      );

    const first = await upload(`cors-replay-${target.id}`);
    const second = await upload(`cors-replay-${target.id}`);

    expect(first.status).toBe(200);
    expect(first.replayed).toBeNull();
    expect(second.status).toBe(200);
    expect(second.replayed).toBe("true");
    expect(second.requestId).toBeTruthy();
  });
});
