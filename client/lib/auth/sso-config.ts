import type { ServerEnv } from "@/lib/env.schema";

export const SSO_PROVIDER_ID = "tessa-sso";
export const SSO_PROVIDER_NAME = "Tessa SSO";

export type SsoEnv = Pick<
  ServerEnv,
  "AUTH_OIDC_ISSUER" | "AUTH_OIDC_CLIENT_ID" | "AUTH_OIDC_CLIENT_SECRET"
>;

export type SsoConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
};

export function resolveSsoConfig(env: SsoEnv): SsoConfig | null {
  const { AUTH_OIDC_ISSUER, AUTH_OIDC_CLIENT_ID, AUTH_OIDC_CLIENT_SECRET } = env;
  if (!AUTH_OIDC_ISSUER || !AUTH_OIDC_CLIENT_ID || !AUTH_OIDC_CLIENT_SECRET) {
    return null;
  }
  return {
    issuer: AUTH_OIDC_ISSUER,
    clientId: AUTH_OIDC_CLIENT_ID,
    clientSecret: AUTH_OIDC_CLIENT_SECRET,
  };
}
