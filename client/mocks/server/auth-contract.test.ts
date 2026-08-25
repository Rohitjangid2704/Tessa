import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_USER, INACTIVE_USER, MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import { bearer, mintApiToken } from "@/tests/utils/tokens";

const SERVICE_KEY = "dev-only-service-key-0123456789abcdefgh";
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function verify(body: unknown, headers: Record<string, string> = { "X-Service-Key": SERVICE_KEY }) {
  return fetch(`${running.baseUrl}/api/v1/auth/credentials/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function me(headers: Record<string, string>) {
  return fetch(`${running.baseUrl}/api/v1/users/me`, { headers });
}

const adminCredentials = { email: ADMIN_USER.email, password: ADMIN_USER.password };

describe("POST /api/v1/auth/credentials/verify", () => {
  it("returns AuthUser for the bootstrap admin", async () => {
    const response = await verify(adminCredentials);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: ADMIN_USER.id,
      email: "admin@tessa.local",
      name: "Admin",
      role: "admin",
    });
  });

  it("never returns the password or the active flag", async () => {
    const body = await (await verify(adminCredentials)).json();
    expect(Object.keys(body).sort()).toEqual(["email", "id", "name", "role"]);
  });

  it("matches the email case-insensitively and trims it", async () => {
    const response = await verify({
      email: "  ADMIN@Tessa.Local ",
      password: "dev-only-admin-password-1",
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ["member", MEMBER_USER],
    ["viewer", VIEWER_USER],
  ])("returns the %s account with its role", async (_label, user) => {
    const response = await verify({ email: user.email, password: user.password });
    expect(response.status).toBe(200);
    expect((await response.json()).role).toBe(user.role);
  });

  it("answers 401 unauthenticated without a service key", async () => {
    const response = await verify(adminCredentials, {});
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.message).toBe("Invalid service key");
  });

  it("answers 401 unauthenticated with a wrong service key", async () => {
    const response = await verify(adminCredentials, { "X-Service-Key": `${SERVICE_KEY}x` });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
  });

  it("checks the service key before the body", async () => {
    const response = await verify({}, {});
    expect(response.status).toBe(401);
  });

  it("answers 401 invalid_credentials for a wrong password", async () => {
    const response = await verify({ email: ADMIN_USER.email, password: "wrong-password" });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("invalid_credentials");
    expect(body.error.message).toBe("Invalid email or password");
  });

  it("gives the same answer for an unknown email and for an inactive user", async () => {
    const unknown = await verify({ email: "nobody@tessa.local", password: "whatever-1" });
    const inactive = await verify({ email: INACTIVE_USER.email, password: INACTIVE_USER.password });

    expect(unknown.status).toBe(401);
    expect(inactive.status).toBe(401);
    expect((await unknown.json()).error.code).toBe("invalid_credentials");
    expect((await inactive.json()).error.code).toBe("invalid_credentials");
  });

  it("answers 422 validation_failed with FastAPI-style details", async () => {
    const response = await verify({ email: "ab" });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toEqual([
      {
        loc: ["body", "email"],
        code: "string_too_short",
        message: "String should have at least 3 characters",
      },
      { loc: ["body", "password"], code: "missing", message: "Field required" },
    ]);
  });

  it("answers 422 for a body that is not JSON", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/auth/credentials/verify`, {
      method: "POST",
      headers: { "X-Service-Key": SERVICE_KEY, "Content-Type": "application/json" },
      body: "{not json",
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.details[0].code).toBe("json_invalid");
  });

  it("answers 429 rate_limited with Retry-After after five failures, even for the right password", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await verify({ email: ADMIN_USER.email, password: "wrong-password" });
      expect(failure.status).toBe(401);
    }

    const blocked = await verify(adminCredentials);
    const body = await blocked.json();

    expect(blocked.status).toBe(429);
    expect(body.error.code).toBe("rate_limited");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  });

  it("counts failures per email", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verify({ email: ADMIN_USER.email, password: "wrong-password" });
    }
    const other = await verify({ email: MEMBER_USER.email, password: MEMBER_USER.password });
    expect(other.status).toBe(200);
  });

  it("forgets earlier failures after a successful login", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await verify({ email: ADMIN_USER.email, password: "wrong-password" });
    }
    expect((await verify(adminCredentials)).status).toBe(200);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await verify({ email: ADMIN_USER.email, password: "wrong-password" });
    }
    expect((await verify(adminCredentials)).status).toBe(200);
  });

  it("answers 429 for every attempt while the verify_429 fault is on", async () => {
    mockState.faults.apply({ verify_429: true });

    const response = await verify(adminCredentials);
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(body.error.code).toBe("rate_limited");

    mockState.faults.apply({ verify_429: false });
    expect((await verify(adminCredentials)).status).toBe(200);
  });
});

describe("GET /api/v1/users/me", () => {
  it("returns the user named by the token, not by the token claims", async () => {
    const token = await mintApiToken({ user: { ...MEMBER_USER, role: "admin" } });
    const response = await me(bearer(token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: MEMBER_USER.id,
      email: MEMBER_USER.email,
      name: MEMBER_USER.name,
      role: "member",
    });
  });

  it("answers 401 unauthenticated without a token and sets WWW-Authenticate", async () => {
    const response = await me({});
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(body.error.code).toBe("unauthenticated");
  });

  it("ignores a non-bearer scheme", async () => {
    const response = await me({ Authorization: "Basic YWRtaW46c2VjcmV0" });
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toBe("Authentication required");
  });

  it("answers 401 token_expired for an expired token", async () => {
    const token = await mintApiToken({ issuedAtSeconds: Math.floor(Date.now() / 1000) - 3600 });
    const response = await me(bearer(token));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("token_expired");
  });

  it("accepts a token that expired within the five second leeway", async () => {
    const token = await mintApiToken({ ttlSeconds: -2 });
    expect((await me(bearer(token))).status).toBe(200);
  });

  it.each([
    ["a garbage token", () => Promise.resolve("not.a.jwt")],
    ["a wrong secret", () => mintApiToken({ secret: "dev-only-some-other-secret-0123456789ab" })],
    ["another algorithm", () => mintApiToken({ algorithm: "HS512" })],
    ["a wrong issuer", () => mintApiToken({ issuer: "someone-else" })],
    ["a wrong audience", () => mintApiToken({ audience: "someone-else" })],
    ["a missing sub", () => mintApiToken({ omitClaims: ["sub"] })],
    ["a missing exp", () => mintApiToken({ omitClaims: ["exp"] })],
    ["a missing iat", () => mintApiToken({ omitClaims: ["iat"] })],
    ["a missing iss", () => mintApiToken({ omitClaims: ["iss"] })],
    ["a missing aud", () => mintApiToken({ omitClaims: ["aud"] })],
  ])("answers 401 unauthenticated for %s", async (_label, makeToken) => {
    const response = await me(bearer(await makeToken()));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.message).toBe("Invalid token");
  });

  it("answers 401 for a subject that is not a UUID", async () => {
    const response = await me(bearer(await mintApiToken({ subject: "not-a-uuid" })));
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toBe("Invalid token subject");
  });

  it("answers 401 for a user that does not exist", async () => {
    const token = await mintApiToken({ subject: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8eff" });
    const response = await me(bearer(token));
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toBe("Unknown or inactive user");
  });

  it("answers 401 for an inactive user", async () => {
    const response = await me(bearer(await mintApiToken({ user: INACTIVE_USER })));
    expect(response.status).toBe(401);
  });

  it("answers 401 token_expired exactly once while token_expired_once is on", async () => {
    mockState.faults.apply({ token_expired_once: true });
    const token = await mintApiToken();

    const first = await me(bearer(token));
    const second = await me(bearer(token));

    expect(first.status).toBe(401);
    expect((await first.json()).error.code).toBe("token_expired");
    expect(second.status).toBe(200);
    expect(mockState.faults.snapshot().token_expired_once).toBe(0);
  });

  it("does not spend token_expired_once on a request without a valid token", async () => {
    mockState.faults.apply({ token_expired_once: true });

    expect((await me({})).status).toBe(401);
    expect(mockState.faults.snapshot().token_expired_once).toBe(1);
  });

  it("supports a count for token_expired_once", async () => {
    mockState.faults.apply({ token_expired_once: 2 });
    const token = await mintApiToken();

    const statuses = [];
    for (let request = 0; request < 3; request += 1) {
      statuses.push((await me(bearer(token))).status);
    }

    expect(statuses).toEqual([401, 401, 200]);
  });

  it("verifies against the secret from the configuration", async () => {
    const rotatedSecret = "dev-only-rotated-secret-0123456789abcdef";
    mockState.configure({ apiJwtSecret: rotatedSecret });
    try {
      expect((await me(bearer(await mintApiToken()))).status).toBe(200);
      expect((await me(bearer(await mintApiToken({ secret: rotatedSecret })))).status).toBe(200);
    } finally {
      mockState.restoreConfig();
    }
  });
});

describe("request id and error body", () => {
  it("echoes a valid X-Request-ID in the header and in the error body", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/users/me`, {
      headers: { "X-Request-ID": "client-request-0001" },
    });
    const body = await response.json();

    expect(response.headers.get("x-request-id")).toBe("client-request-0001");
    expect(body.error.request_id).toBe("client-request-0001");
  });

  it("generates a UUIDv7 request id when the client sends none or an invalid one", async () => {
    const withoutHeader = await fetch(`${running.baseUrl}/api/v1/users/me`);
    const withInvalid = await fetch(`${running.baseUrl}/api/v1/users/me`, {
      headers: { "X-Request-ID": "bad id" },
    });

    for (const response of [withoutHeader, withInvalid]) {
      const generated = response.headers.get("x-request-id") ?? "";
      expect(generated).toMatch(UUID_V7_PATTERN);
      expect((await response.json()).error.request_id).toBe(generated);
    }
  });

  it("returns the ErrorResponse shape for 404 and 405", async () => {
    const missing = await fetch(`${running.baseUrl}/api/v1/nothing-here`);
    const wrongMethod = await fetch(`${running.baseUrl}/health`, { method: "POST" });

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: "not_found",
        message: "Not Found",
        request_id: missing.headers.get("x-request-id"),
        details: [],
      },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect((await wrongMethod.json()).error.code).toBe("method_not_allowed");
  });

  it("answers 403 role_required when the role is too low", async () => {
    const token = await mintApiToken({ user: VIEWER_USER });
    const response = await fetch(`${running.baseUrl}/api/v1/system/hello-runs`, {
      method: "POST",
      headers: {
        ...bearer(token),
        "Content-Type": "application/json",
        "Idempotency-Key": "viewer-key-0001",
      },
      body: "{}",
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("role_required");
    expect(body.error.message).toBe("Requires role member or higher");
  });
});
