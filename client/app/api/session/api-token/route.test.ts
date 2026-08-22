import { jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importSigningKey } from "@/lib/auth/api-token";
import { GET } from "./route";

const getSessionUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/dal", () => ({ getSessionUser }));

vi.mock("@/lib/env.server", () => ({
  getServerEnv: () => ({
    API_JWT_SECRET: "dev-only-api-jwt-secret-0123456789abcdef",
    API_JWT_ISSUER: "tessa-web",
    API_JWT_AUDIENCE: "tessa-api",
    API_JWT_TTL_SECONDS: 300,
  }),
}));

const user = {
  id: "01a0f6a3-7fa4-75e1-acdf-e605bc8317d6",
  email: "member@tessa.local",
  name: "Member",
  role: "member",
};

beforeEach(() => {
  getSessionUser.mockReset();
});

describe("GET /api/session/api-token", () => {
  it("answers 401 with a contract error body and no-store when there is no session", async () => {
    getSessionUser.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.error).toMatchObject({ code: "unauthenticated", details: [] });
    expect(body.error.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty("token");
  });

  it("returns a token and its expiry, never cached", async () => {
    getSessionUser.mockResolvedValue(user);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["expires_at", "token"]);
    expect(new Date(body.expires_at).toISOString()).toBe(body.expires_at);
  });

  it("signs claims for the session user that the API's verifier accepts", async () => {
    getSessionUser.mockResolvedValue(user);

    const { token, expires_at: expiresAt } = await (await GET()).json();
    const { payload, protectedHeader } = await jwtVerify(
      token,
      await importSigningKey("dev-only-api-jwt-secret-0123456789abcdef"),
      {
        algorithms: ["HS256"],
        issuer: "tessa-web",
        audience: "tessa-api",
        requiredClaims: ["exp", "iss", "aud", "sub", "iat", "jti"],
      },
    );

    expect(protectedHeader.typ).toBe("JWT");
    expect(payload).toMatchObject({ sub: user.id, email: user.email, role: "member" });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
    expect(new Date(expiresAt).getTime()).toBe((payload.exp ?? 0) * 1000);
  });
});
