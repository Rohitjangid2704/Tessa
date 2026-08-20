import {
  formatRetryDelay,
  isLoginErrorCode,
  loginErrorMessages,
  type LoginErrorCode,
} from "./login-errors";

export const ssoNoticeCodes = ["access_denied", "sso_unavailable", "sso_cancelled"] as const;

export type SsoNoticeCode = (typeof ssoNoticeCodes)[number];

export type LoginNoticeCode = LoginErrorCode | SsoNoticeCode;

export type LoginNoticeText = {
  title: string;
  description: string;
};

export type LoginNoticeOptions = {
  passwordAvailable: boolean;
  retryAfterSeconds?: number | null;
};

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function loginNoticeFromSearch(
  error: string | string[] | undefined,
  code: string | string[] | undefined,
): LoginNoticeCode | null {
  const errorValue = firstValue(error);
  if (!errorValue) {
    return null;
  }
  switch (errorValue) {
    case "AccessDenied":
      return "access_denied";
    case "Configuration":
      return "sso_unavailable";
    case "OAuthCallbackError":
      return "sso_cancelled";
    case "CredentialsSignin": {
      const codeValue = firstValue(code);
      return isLoginErrorCode(codeValue) ? codeValue : "invalid_credentials";
    }
    default:
      return "service_unavailable";
  }
}

export function describeLoginNotice(
  code: LoginNoticeCode,
  { passwordAvailable, retryAfterSeconds = null }: LoginNoticeOptions,
): LoginNoticeText {
  switch (code) {
    case "access_denied":
      return {
        title: "Account not provisioned",
        description:
          "Your Tessa SSO account has no Tessa role yet. Ask an administrator to map your group to a role, then sign in again. Signing out of Tessa does not end your SSO session, so sign out at your identity provider to switch accounts.",
      };
    case "sso_unavailable":
      return {
        title: "Single sign-on is unavailable",
        description: passwordAvailable
          ? "Tessa could not reach the identity provider, or its settings are invalid. Try again, or sign in with your password."
          : "Tessa could not reach the identity provider, or its settings are invalid. Try again in a moment, and ask an administrator if it keeps failing.",
      };
    case "sso_cancelled":
      return {
        title: "Single sign-on was not completed",
        description:
          "The identity provider cancelled or refused the request. Try signing in again.",
      };
    case "rate_limited":
      return {
        title: "Too many sign-in attempts",
        description:
          retryAfterSeconds === null
            ? loginErrorMessages.rate_limited
            : `Too many sign-in attempts. Try again in ${formatRetryDelay(retryAfterSeconds)}.`,
      };
    case "invalid_credentials":
      return { title: "Sign-in failed", description: loginErrorMessages.invalid_credentials };
    case "service_unavailable":
      return {
        title: "Sign-in is unavailable",
        description: loginErrorMessages.service_unavailable,
      };
  }
}
