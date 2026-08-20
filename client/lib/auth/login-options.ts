import "server-only";
import { getServerEnv } from "@/lib/env.server";
import type { ServerEnv } from "@/lib/env.schema";
import { SSO_PROVIDER_NAME, resolveSsoConfig, type SsoEnv } from "./sso-config";

export type LoginOptions = {
  passwordEnabled: boolean;
  sso: { providerName: string } | null;
};

export function resolveLoginOptions(
  env: SsoEnv & Pick<ServerEnv, "AUTH_PASSWORD_LOGIN_ENABLED">,
): LoginOptions {
  return {
    passwordEnabled: env.AUTH_PASSWORD_LOGIN_ENABLED,
    sso: resolveSsoConfig(env) ? { providerName: SSO_PROVIDER_NAME } : null,
  };
}

export function getLoginOptions(): LoginOptions {
  return resolveLoginOptions(getServerEnv());
}
