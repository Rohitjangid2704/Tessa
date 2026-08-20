import { decodeProtectedHeader, jwtVerify, errors } from "jose";
import { describe, expect, it } from "vitest";
import { importSigningKey, mintApiToken, type ApiTokenEnv } from "./api-token";

const env: ApiTokenEnv = {
  API_JWT_SECRET: "dev-only-api-jwt-secret-0123456789abcdef",
  API_JWT_ISSUER: "tessa-web",
  API_JWT_AUDIENCE: "tessa-api",
  API_JWT_TTL_SECONDS: 300,
};

const subject = {
  id: "01a0f6a3-7fa4-75e1-acdf-e605bc8317d6",
  email: "admin@tessa.local",
  role: "admin",
} as const;

const issuedAt = new Date("2026-10-01T10:00:00.250Z");

async function verify(
  token: string,
  overrides: { secret?: string; audience?: string; issuer?: string } = {},
) {
  return jwtVerify(token, await importSigningKey(overrides.secret ?? env.API_JWT_SECRET), {
    algorithms: ["HS256"],
    issuer: overrides.issuer ?? env.API_JWT_ISSUER,
    audience: overrides.audience ?? env.API_JWT_AUDIENCE,
    requiredClaims: ["exp", "iss", "aud", "sub"],
    currentDate: issuedAt,
  });
}

describe("mintApiToken", () => {
  it("signs an HS256 JWT with the claims the API requires", async () => {
    const { token } = await mintApiToken(subject, env, issuedAt);

    const { payload, protectedHeader } = await verify(token);

    expect(protectedHeader).toMatchObject({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({
      iss: "tessa-web",
      aud: "tessa-api",
      sub: subject.id,
      email: subject.email,
      role: "admin",
    });
    expect(payload.iat).toBe(Math.floor(issuedAt.getTime() / 1000));
    expect(payload.exp).toBe((payload.iat ?? 0) + 300);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports the expiry as an ISO timestamp equal to the exp claim", async () => {
    const { token, expires_at: expiresAt } = await mintApiToken(subject, env, issuedAt);

    const { payload } = await verify(token);

    expect(expiresAt).toBe(new Date((payload.exp ?? 0) * 1000).toISOString());
    expect(expiresAt).toBe("2026-10-01T10:05:00.000Z");
  });

  it("follows API_JWT_TTL_SECONDS", async () => {
    const { token } = await mintApiToken(subject, { ...env, API_JWT_TTL_SECONDS: 120 }, issuedAt);

    const { payload } = await verify(token);

    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(120);
  });

  it("gives every token its own jti", async () => {
    const first = await verify((await mintApiToken(subject, env, issuedAt)).token);
    const second = await verify((await mintApiToken(subject, env, issuedAt)).token);

    expect(first.payload.jti).not.toBe(second.payload.jti);
  });

  it("is rejected with another secret, issuer or audience", async () => {
    const { token } = await mintApiToken(subject, env, issuedAt);

    await expect(
      verify(token, { secret: "dev-only-other-secret-0123456789abcdefgh" }),
    ).rejects.toBeInstanceOf(errors.JWSSignatureVerificationFailed);
    await expect(verify(token, { issuer: "someone-else" })).rejects.toBeInstanceOf(
      errors.JWTClaimValidationFailed,
    );
    await expect(verify(token, { audience: "another-api" })).rejects.toBeInstanceOf(
      errors.JWTClaimValidationFailed,
    );
  });

  it("is expired after its lifetime", async () => {
    const { token } = await mintApiToken(subject, env, issuedAt);

    await expect(
      jwtVerify(token, await importSigningKey(env.API_JWT_SECRET), {
        algorithms: ["HS256"],
        currentDate: new Date(issuedAt.getTime() + 301_000),
      }),
    ).rejects.toBeInstanceOf(errors.JWTExpired);
  });

  it("puts the algorithm in the protected header", async () => {
    const { token } = await mintApiToken(subject, env, issuedAt);

    expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", typ: "JWT" });
  });
});
