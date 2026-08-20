import { SignJWT } from "jose";
import type { ServerEnv } from "@/lib/env.schema";
import type { ApiTokenResponse, UserRole } from "./schemas";

export type ApiTokenEnv = Pick<
  ServerEnv,
  "API_JWT_SECRET" | "API_JWT_ISSUER" | "API_JWT_AUDIENCE" | "API_JWT_TTL_SECONDS"
>;

export type ApiTokenSubject = {
  id: string;
  email: string;
  role: UserRole;
};

export function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function mintApiToken(
  subject: ApiTokenSubject,
  env: ApiTokenEnv,
  now: Date = new Date(),
): Promise<ApiTokenResponse> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + env.API_JWT_TTL_SECONDS;
  const token = await new SignJWT({ email: subject.email, role: subject.role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(env.API_JWT_ISSUER)
    .setAudience(env.API_JWT_AUDIENCE)
    .setSubject(subject.id)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setJti(crypto.randomUUID())
    .sign(await importSigningKey(env.API_JWT_SECRET));
  return { token, expires_at: new Date(expiresAt * 1000).toISOString() };
}
