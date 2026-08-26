import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { expect, type Page } from "@playwright/test";
import { apiOrigin } from "../../helpers/env";

export interface ApiResult<T> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

export async function mintApiToken(page: Page): Promise<string> {
  const response = await page.request.get("/api/session/api-token");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

export async function apiRequest<T>(
  page: Page,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { data?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const token = await mintApiToken(page);
  const response = await page.request.fetch(`${apiOrigin()}${path}`, {
    method,
    data: options.data,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
  const text = await response.text();
  return {
    status: response.status(),
    headers: response.headers(),
    body: (text === "" ? null : JSON.parse(text)) as T,
  };
}

export async function apiGet<T>(page: Page, path: string): Promise<ApiResult<T>> {
  return apiRequest<T>(page, "GET", path);
}

export async function uploadBundleFile(
  page: Page,
  filePath: string,
  idempotencyKey: string,
): Promise<ApiResult<{ bundle: { id: string; version: number }; created: boolean }>> {
  const token = await mintApiToken(page);
  const response = await page.request.post(`${apiOrigin()}/api/v1/bundles`, {
    headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": idempotencyKey },
    multipart: {
      file: {
        name: basename(filePath),
        mimeType: "application/zip",
        buffer: readFileSync(filePath),
      },
    },
  });
  return {
    status: response.status(),
    headers: response.headers(),
    body: await response.json(),
  };
}
