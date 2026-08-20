export const loginErrorCodes = [
  "invalid_credentials",
  "rate_limited",
  "service_unavailable",
] as const;

export type LoginErrorCode = (typeof loginErrorCodes)[number];

export const loginErrorMessages: Record<LoginErrorCode, string> = {
  invalid_credentials: "The email or password is incorrect.",
  rate_limited: "Too many sign-in attempts. Wait a minute, then try again.",
  service_unavailable: "Tessa could not sign you in right now. Try again in a moment.",
};

export function formatRetryDelay(seconds: number): string {
  if (seconds < 60) {
    const shown = Math.max(1, seconds);
    return `${shown} ${shown === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function loginErrorMessage(code: LoginErrorCode, retryAfter?: number | null): string {
  if (code === "rate_limited" && typeof retryAfter === "number") {
    return `Too many sign-in attempts. Try again in ${formatRetryDelay(retryAfter)}.`;
  }
  return loginErrorMessages[code];
}

export function resolveRetryAfterSeconds(error: unknown): number | null {
  if (
    error instanceof Error &&
    "retryAfterSeconds" in error &&
    typeof error.retryAfterSeconds === "number"
  ) {
    return error.retryAfterSeconds;
  }
  return null;
}

export function isLoginErrorCode(value: unknown): value is LoginErrorCode {
  return typeof value === "string" && (loginErrorCodes as readonly string[]).includes(value);
}

export function loginErrorFromSearch(
  error: string | string[] | undefined,
  code: string | string[] | undefined,
): LoginErrorCode | null {
  const errorValue = Array.isArray(error) ? error[0] : error;
  const codeValue = Array.isArray(code) ? code[0] : code;
  if (!errorValue) {
    return null;
  }
  if (errorValue === "CredentialsSignin") {
    return isLoginErrorCode(codeValue) ? codeValue : "invalid_credentials";
  }
  return "service_unavailable";
}

export function isAuthJsError(error: unknown): boolean {
  return error instanceof Error && "type" in error;
}

export function resolveLoginError(error: unknown): LoginErrorCode | null {
  if (!(error instanceof Error) || !("type" in error)) {
    return null;
  }
  if (error.type === "CredentialsSignin") {
    return "code" in error && isLoginErrorCode(error.code) ? error.code : "invalid_credentials";
  }
  return "service_unavailable";
}
