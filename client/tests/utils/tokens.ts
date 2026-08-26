import { SignJWT } from "jose";
import { ADMIN_USER } from "@/mocks/factories/users";
import { newId } from "@/mocks/factories/ids";
import { secretKey } from "@/mocks/factories/keys";
import { mockState } from "@/mocks/state";
import type { MockUser } from "@/mocks/types";

type TokenClaim = "iss" | "aud" | "sub" | "iat" | "exp";

export interface MintApiTokenOptions {
  user?: Pick<MockUser, "id" | "email" | "role">;
  subject?: string;
  secret?: string;
  issuer?: string;
  audience?: string;
  algorithm?: "HS256" | "HS384" | "HS512";
  issuedAtSeconds?: number;
  ttlSeconds?: number;
  omitClaims?: readonly TokenClaim[];
}

const DEFAULT_TTL_SECONDS = 300;

export async function mintApiToken(options: MintApiTokenOptions = {}): Promise<string> {
  const { config } = mockState;
  const user = options.user ?? ADMIN_USER;
  const issuedAt = options.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: options.issuer ?? config.apiJwtIssuer,
    aud: options.audience ?? config.apiJwtAudience,
    sub: options.subject ?? user.id,
    email: user.email,
    role: user.role,
    iat: issuedAt,
    exp: issuedAt + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    jti: newId(),
  };
  for (const claim of options.omitClaims ?? []) {
    delete claims[claim];
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: options.algorithm ?? "HS256", typ: "JWT" })
    .sign(secretKey(options.secret ?? config.apiJwtSecret));
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
