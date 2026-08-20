import { CredentialsSignin } from "next-auth";
import { parseRetryAfterSeconds } from "@/lib/api/errors";
import type { ServerEnv } from "@/lib/env.schema";
import { authUserSchema, loginInputSchema, type AuthUser } from "./schemas";

export class InvalidCredentialsError extends CredentialsSignin {
  code = "invalid_credentials";
}

export class RateLimitedError extends CredentialsSignin {
  code = "rate_limited";
  retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null = null) {
    super();
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ServiceUnavailableError extends CredentialsSignin {
  code = "service_unavailable";
}

export type VerifyCredentialsEnv = Pick<ServerEnv, "API_INTERNAL_URL" | "API_SERVICE_KEY">;

export const CREDENTIALS_VERIFY_PATH = "/api/v1/auth/credentials/verify";

export async function verifyCredentials(
  email: string,
  password: string,
  env: VerifyCredentialsEnv,
): Promise<AuthUser> {
  let response: Response;
  try {
    response = await fetch(`${env.API_INTERNAL_URL}${CREDENTIALS_VERIFY_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Service-Key": env.API_SERVICE_KEY,
      },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
  } catch {
    throw new ServiceUnavailableError();
  }

  if (response.status === 401 || response.status === 422) {
    throw new InvalidCredentialsError();
  }
  if (response.status === 429) {
    throw new RateLimitedError(parseRetryAfterSeconds(response.headers.get("Retry-After")));
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
  return user.data;
}

export async function authorizeCredentials(
  credentials: Partial<Record<string, unknown>>,
  env: VerifyCredentialsEnv,
): Promise<AuthUser> {
  const input = loginInputSchema.safeParse(credentials);
  if (!input.success) {
    throw new InvalidCredentialsError();
  }
  return verifyCredentials(input.data.email, input.data.password, env);
}
