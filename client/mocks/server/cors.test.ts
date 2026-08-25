import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_EXPOSED_HEADERS,
  CORS_MAX_AGE_SECONDS,
} from "@/mocks/config";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import type { RunningMockServer } from "@/mocks/server/http";

const ALLOWED_ORIGIN = "http://localhost:3000";
const ALLOWED_LOOPBACK_ORIGIN = "http://127.0.0.1:3000";
const FOREIGN_ORIGIN = "http://evil.example";

let running: RunningMockServer;

beforeAll(async () => {
  running = await startMockApi();
});

afterAll(async () => {
  await running.close();
});

beforeEach(() => {
  mockState.reset();
});

function preflight(origin: string, requestMethod: string, requestHeaders?: string) {
  return fetch(`${running.baseUrl}/api/v1/users/me`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": requestMethod,
      ...(requestHeaders === undefined ? {} : { "Access-Control-Request-Headers": requestHeaders }),
    },
  });
}

describe("preflight", () => {
  it("answers an allowed origin with the contract methods, headers and cache age", async () => {
    const response = await preflight(ALLOWED_ORIGIN, "GET", "authorization,x-request-id");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe(
      CORS_ALLOWED_METHODS.join(", "),
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type, Idempotency-Key, Last-Event-ID, X-Request-ID",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      CORS_ALLOWED_HEADERS.join(", "),
    );
    expect(response.headers.get("access-control-max-age")).toBe(String(CORS_MAX_AGE_SECONDS));
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("never allows credentials", async () => {
    const response = await preflight(ALLOWED_ORIGIN, "POST", "authorization,content-type");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
  });

  it("allows the loopback origin of the dev server", async () => {
    const response = await preflight(ALLOWED_LOOPBACK_ORIGIN, "POST", "idempotency-key");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_LOOPBACK_ORIGIN);
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])("allows the %s method", async (method) => {
    const response = await preflight(ALLOWED_ORIGIN, method);
    expect(response.status).toBe(200);
  });

  it("allows Last-Event-ID for the SSE reader", async () => {
    const response = await preflight(ALLOWED_ORIGIN, "GET", "authorization,last-event-id");
    expect(response.status).toBe(200);
  });

  it("allows safelisted request headers without listing them", async () => {
    const response = await preflight(ALLOWED_ORIGIN, "POST", "content-type,accept");
    expect(response.status).toBe(200);
  });

  it("rejects an origin outside the list", async () => {
    const response = await preflight(FOREIGN_ORIGIN, "GET", "authorization");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Disallowed CORS origin");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("rejects a method outside the list", async () => {
    const response = await preflight(ALLOWED_ORIGIN, "TRACE");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Disallowed CORS method");
  });

  it.each(["x-service-key", "cookie", "authorization,x-custom"])(
    "rejects the request header %s",
    async (headers) => {
      const response = await preflight(ALLOWED_ORIGIN, "POST", headers);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Disallowed CORS headers");
    },
  );

  it("follows a changed origin list", async () => {
    mockState.configure({ corsOrigins: [FOREIGN_ORIGIN] });
    try {
      expect((await preflight(FOREIGN_ORIGIN, "GET")).status).toBe(200);
      expect((await preflight(ALLOWED_ORIGIN, "GET")).status).toBe(400);
    } finally {
      mockState.restoreConfig();
    }
  });

  it("treats an OPTIONS request without a request method as a plain 405", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/users/me`, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(response.status).toBe(405);
    const body = await response.json();
    expect(body.error.code).toBe("method_not_allowed");
    expect(response.headers.get("allow")).toBe("GET");
  });
});

describe("actual requests", () => {
  it("echoes an allowed origin and exposes exactly the contract headers", async () => {
    const response = await fetch(`${running.baseUrl}/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-Request-ID, Idempotency-Replayed, Retry-After, Content-Disposition",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      CORS_EXPOSED_HEADERS.join(", "),
    );
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
  });

  it("adds the CORS headers to error responses too", async () => {
    const unauthorized = await fetch(`${running.baseUrl}/api/v1/users/me`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const missing = await fetch(`${running.baseUrl}/nope`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  it("withholds the allow-origin header from a foreign origin", async () => {
    const response = await fetch(`${running.baseUrl}/health`, {
      headers: { Origin: FOREIGN_ORIGIN },
    });
    expect(response.status).toBe(200);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("adds no CORS headers when there is no Origin header", async () => {
    const response = await fetch(`${running.baseUrl}/health`);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.has("access-control-expose-headers")).toBe(false);
  });
});
