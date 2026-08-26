import { e2eEnvKeys, e2eEnvSchema, pickEnv, type E2eEnv } from "../../../lib/env.schema";

export const DEFAULT_APP_URL = "http://localhost:3000";
export const DEFAULT_API_URL = "http://localhost:8000";

export function readE2eEnv(source: Record<string, string | undefined> = process.env): E2eEnv {
  return e2eEnvSchema.parse(pickEnv(source, e2eEnvKeys));
}

export interface E2eCredentials {
  email: string;
  password: string;
}

export function readE2eCredentials(
  source: Record<string, string | undefined> = process.env,
): E2eCredentials {
  const env = readE2eEnv(source);
  if (env.E2E_USER_EMAIL === undefined || env.E2E_USER_PASSWORD === undefined) {
    throw new Error("E2E_USER_EMAIL and E2E_USER_PASSWORD must be set to sign in");
  }
  return { email: env.E2E_USER_EMAIL, password: env.E2E_USER_PASSWORD };
}

export function apiOrigin(source: Record<string, string | undefined> = process.env): string {
  return new URL(source.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL).origin;
}
