import type { Profile } from "next-auth";
import type { OIDCConfig } from "next-auth/providers";
import type { SsoProvisionRequest } from "@/lib/api/types";
import type { ServerEnv } from "@/lib/env.schema";
import { RateLimitedError, ServiceUnavailableError } from "./credentials";
import { authUserSchema, type AuthUser, type UserRole } from "./schemas";
import { SSO_PROVIDER_ID, SSO_PROVIDER_NAME, type SsoConfig } from "./sso-config";

export const SSO_PROVISION_PATH = "/api/v1/auth/sso/provision";

export type SsoProvisionEnv = Pick<ServerEnv, "API_INTERNAL_URL" | "API_SERVICE_KEY">;

export type SsoProvisionResult = { kind: "provisioned"; user: AuthUser } | { kind: "denied" };

export type SsoSessionUser = {
  id?: string;
  email?: string | null;
  name?: string | null;
  role?: UserRole;
};

export type SsoSignInInput = {
  user: SsoSessionUser;
  profile: Record<string, unknown> | undefined;
};

export function createSsoProvider(config: SsoConfig): OIDCConfig<Profile> {
  return {
    id: SSO_PROVIDER_ID,
    name: SSO_PROVIDER_NAME,
    type: "oidc",
    issuer: config.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    checks: ["pkce", "state", "nonce"],
  };
}

function readClaimText(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildProvisionRequest(
  claims: Record<string, unknown> | undefined,
  fallbackIssuer: string,
): SsoProvisionRequest | null {
  if (!claims) {
    return null;
  }
  const subject = readClaimText(claims, "sub");
  const email = readClaimText(claims, "email");
  if (subject === null || email === null) {
    return null;
  }
  return {
    issuer: readClaimText(claims, "iss") ?? fallbackIssuer,
    subject,
    email,
    name: readClaimText(claims, "name") ?? readClaimText(claims, "preferred_username"),
    claims,
  };
}

export async function provisionSsoUser(
  request: SsoProvisionRequest,
  env: SsoProvisionEnv,
): Promise<SsoProvisionResult> {
  let response: Response;
  try {
    response = await fetch(`${env.API_INTERNAL_URL}${SSO_PROVISION_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Service-Key": env.API_SERVICE_KEY,
      },
      body: JSON.stringify(request),
      cache: "no-store",
    });
  } catch {
    throw new ServiceUnavailableError();
  }

  if (response.status === 403 || response.status === 422) {
    return { kind: "denied" };
  }
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new ServiceUnavailableError();
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ServiceUnavailableError();
  }
  const user = authUserSchema.safeParse(body);
  if (!user.success) {
    throw new ServiceUnavailableError();
  }
  return { kind: "provisioned", user: user.data };
}

export async function completeSsoSignIn(
  { user, profile }: SsoSignInInput,
  config: Pick<SsoConfig, "issuer">,
  env: SsoProvisionEnv,
): Promise<boolean> {
  const request = buildProvisionRequest(profile, config.issuer);
  if (request === null) {
    return false;
  }
  const result = await provisionSsoUser(request, env);
  if (result.kind === "denied") {
    return false;
  }
  user.id = result.user.id;
  user.email = result.user.email;
  user.name = result.user.name;
  user.role = result.user.role;
  return true;
}
